import type { GeneratorOptions, GeneratorResult } from "@babel/generator";
import invariant from "../invariant";
import { type Cache, getOrSetFromCache } from "./cache";
import {
  type Babel,
  type NodePath,
  parse,
  traverse,
  generate,
  t,
} from "./babel";

type Statement = Babel.Statement;
type Identifier = Babel.Identifier;

type ExportDependencies = Map<string, Dependencies>;

type Dependencies = {
  topLevelStatements: Set<Statement>;
  topLevelNonModuleStatements: Set<Statement>;
  importedIdentifierNames: Set<string>;
};

function codeToAst(code: string, cache: Cache, cacheKey: string): Babel.File {
  // We use structuredClone to allow AST mutation without modifying the cache.
  return structuredClone(
    getOrSetFromCache(cache, `${cacheKey}::codeToAst`, code, () =>
      parse(code, { sourceType: "module" })
    )
  );
}

function getExportDependencies(
  code: string,
  cache: Cache,
  cacheKey: string
): ExportDependencies {
  return getOrSetFromCache(
    cache,
    `${cacheKey}::getExportDependencies`,
    code,
    () => {
      let exportDependencies: ExportDependencies = new Map();
      let ast = codeToAst(code, cache, cacheKey);

      function handleExport(
        exportName: string,
        exportPath: NodePath<Babel.ExportDeclaration>,
        identifiersPath: NodePath = exportPath
      ) {
        let identifiers = getDependentIdentifiersForPath(identifiersPath);

        let topLevelStatements = new Set([
          exportPath.node,
          ...getTopLevelStatementsForPaths(identifiers),
        ]);

        // We also keep track of non-import statements since import statements
        // get more fine-grained filtering, meaning that we often need to
        // exclude import statements in our chunking logic.
        let topLevelNonModuleStatements = new Set(
          Array.from(topLevelStatements).filter(
            (statement) =>
              !t.isImportDeclaration(statement) &&
              !t.isExportDeclaration(statement)
          )
        );

        // We keep track of imported identifiers for each export since we
        // perform more fine-grained filtering on import statements.
        let importedIdentifierNames = new Set<string>();
        for (let identifier of identifiers) {
          if (identifier.parentPath.parentPath?.isImportDeclaration()) {
            importedIdentifierNames.add(identifier.node.name);
          }
        }

        let dependencies: Dependencies = {
          topLevelStatements,
          topLevelNonModuleStatements,
          importedIdentifierNames,
        };

        exportDependencies.set(exportName, dependencies);
      }

      traverse(ast, {
        ExportDeclaration(exportPath) {
          let { node } = exportPath;

          // export * from "./module"
          if (t.isExportAllDeclaration(node)) {
            return;
          }

          // export default ...;
          if (t.isExportDefaultDeclaration(node)) {
            handleExport("default", exportPath);
            return;
          }

          let { declaration } = node;

          // export const foo = ...;
          if (t.isVariableDeclaration(declaration)) {
            for (let declarator of declaration.declarations) {
              if (t.isIdentifier(declarator.id)) {
                handleExport(declarator.id.name, exportPath);
              }
            }
            return;
          }

          // export function foo() {}
          // export class Foo {}
          if (
            t.isFunctionDeclaration(declaration) ||
            t.isClassDeclaration(declaration)
          ) {
            invariant(
              declaration.id,
              "Expected exported function or class declaration to have a name when not the default export"
            );
            handleExport(declaration.id.name, exportPath);
            return;
          }

          // export { foo, bar }
          if (t.isExportNamedDeclaration(node)) {
            for (let specifier of node.specifiers) {
              if (t.isIdentifier(specifier.exported)) {
                let name = specifier.exported.name;
                let specifierPath = exportPath
                  .get("specifiers")
                  .find((path) => path.node === specifier);

                invariant(
                  specifierPath,
                  `Expected to find specifier path for ${name}`
                );

                handleExport(name, exportPath, specifierPath);
              }
            }
            return;
          }

          // This should never happen:
          // @ts-expect-error: We've handled all the export types
          throw new Error(`Unknown export node type: ${node.type}`);
        },
      });

      return exportDependencies;
    }
  );
}

function getDependentIdentifiersForPath(
  path: NodePath,
  state?: { visited: Set<NodePath>; identifiers: Set<NodePath<Identifier>> }
): Set<NodePath<Identifier>> {
  let { visited, identifiers } = state ?? {
    visited: new Set(),
    identifiers: new Set(),
  };

  visited.add(path);

  // Recursively traverse the AST to find all identifiers the path depends on.
  path.traverse({
    Identifier(path) {
      identifiers.add(path);
      let binding = path.scope.getBinding(path.node.name);
      if (binding?.path && !visited.has(binding.path)) {
        getDependentIdentifiersForPath(binding.path, { visited, identifiers });
      }
    },
  });

  return identifiers;
}

function getTopLevelStatementsForPaths(paths: Set<NodePath>): Set<Statement> {
  let topLevelStatements = new Set<Statement>();

  for (let path of paths) {
    let ancestry = path.getAncestry();

    // The last node is the Program node so we want the ancestor before that.
    let topLevelStatement = ancestry[ancestry.length - 2].node;

    invariant(
      t.isStatement(topLevelStatement),
      `Expected statement, found type "${topLevelStatement.type}"`
    );

    topLevelStatements.add(topLevelStatement);
  }

  return topLevelStatements;
}

const getExportedName = (exported: t.Identifier | t.StringLiteral): string => {
  return t.isIdentifier(exported) ? exported.name : exported.value;
};

function areSetsDisjoint(set1: Set<any>, set2: Set<any>): boolean {
  // To optimize the check, we always iterate over the smaller set.
  let smallerSet = set1;
  let largerSet = set2;
  if (set1.size > set2.size) {
    smallerSet = set2;
    largerSet = set1;
  }

  for (let element of smallerSet) {
    if (largerSet.has(element)) {
      return false;
    }
  }

  return true;
}

export function hasChunkableExport(
  code: string,
  exportName: string,
  cache: Cache,
  cacheKey: string
): boolean {
  return getOrSetFromCache(
    cache,
    `${cacheKey}::hasChunkableExport::${exportName}`,
    code,
    () => {
      let exportDependencies = getExportDependencies(code, cache, cacheKey);
      let dependencies = exportDependencies.get(exportName);

      // If there are no dependencies, the export wasn't found in the file.
      if (!dependencies) {
        return false;
      }

      invariant(
        dependencies.topLevelStatements.size > 0,
        `Expected export "${exportName}" to have top level statements if the set exists`
      );

      // Loop through all other exports to see if they have top level non-import
      // statements in common with the export we're trying to chunk.
      for (let [currentExportName, currentDependencies] of exportDependencies) {
        if (currentExportName === exportName) {
          continue;
        }

        // As soon as we find any top level non-import statements in common with
        // another export, we know this export cannot be placed in its own
        // chunk. The reason import statements aren't factored into this check
        // is because we perform more fine-grained optimizations on them,
        // filtering out all unused imports within each chunk, meaning that it's
        // okay for multiple exports to share an import statement. We perform a
        // deeper check on imported identifiers in the step after this.
        if (
          !areSetsDisjoint(
            currentDependencies.topLevelNonModuleStatements,
            dependencies.topLevelNonModuleStatements
          )
        ) {
          return false;
        }
      }

      // Loop through all other exports to see if they have imported identifiers
      // in common with the export we're trying to chunk.
      if (dependencies.importedIdentifierNames.size > 0) {
        for (let [
          currentExportName,
          currentDependencies,
        ] of exportDependencies) {
          if (currentExportName === exportName) {
            continue;
          }

          // As soon as we find any imported identifiers in common with another
          // export, we know this export cannot be placed in its own chunk. Note
          // that the chunk can still share top level import statements with
          // other exports because we filter out all unused imports, so we can
          // treat each imported identifier as a separate entity in this check.
          if (
            !areSetsDisjoint(
              currentDependencies.importedIdentifierNames,
              dependencies.importedIdentifierNames
            )
          ) {
            return false;
          }
        }
      }

      return true;
    }
  );
}

export function getChunkedExport(
  code: string,
  exportName: string,
  generateOptions: GeneratorOptions = {},
  cache: Cache,
  cacheKey: string
): GeneratorResult | undefined {
  return getOrSetFromCache(
    cache,
    `${cacheKey}::getChunkedExport::${exportName}::${JSON.stringify(
      generateOptions
    )}`,
    code,
    () => {
      // If we already know the export isn't chunkable, we can bail out early.
      if (!hasChunkableExport(code, exportName, cache, cacheKey)) {
        return undefined;
      }

      let exportDependencies = getExportDependencies(code, cache, cacheKey);
      let dependencies = exportDependencies.get(exportName);
      invariant(dependencies, "Expected export to have dependencies");

      let topLevelStatementsArray = Array.from(dependencies.topLevelStatements);

      let ast = codeToAst(code, cache, cacheKey);

      // Filter the AST body to only include statements that are part of the
      // chunked export's dependencies. Note that since we bailed out early if
      // the export isn't chunkable, we can now simply remove any unused imports
      // and top-level statements.
      ast.program.body = ast.program.body
        .filter((node) =>
          topLevelStatementsArray.some((statement) =>
            t.isNodesEquivalent(node, statement)
          )
        )
        // Remove unused imports
        .map((node) => {
          // Skip non-import nodes for this step, return node as-is
          if (!t.isImportDeclaration(node)) {
            return node;
          }

          // If the chunked export doesn't depend on any imported identifiers,
          // we know it can't contain any imports statements, so we remove it.
          if (dependencies.importedIdentifierNames.size === 0) {
            return null;
          }

          // Filter out unused import specifiers. Note that this handles
          // default imports, named imports, and namespace imports.
          node.specifiers = node.specifiers.filter((specifier) =>
            dependencies.importedIdentifierNames.has(specifier.local.name)
          );

          // Ensure we haven't removed all specifiers. If we have, it means
          // our dependency analysis is incorrect.
          invariant(
            node.specifiers.length > 0,
            "Expected import statement to have used specifiers"
          );

          // Keep the modified AST node
          return node;
        })
        // Filter export statements
        .map((node) => {
          // Skip non-export nodes for this step, return node as-is
          if (!t.isExportDeclaration(node)) {
            return node;
          }

          // `export * from "./module";
          // Not chunkable, always remove within chunks.
          if (t.isExportAllDeclaration(node)) {
            return null;
          }

          // export default ...;
          // If we're chunking the default export, keep it,
          // otherwise remove it.
          if (t.isExportDefaultDeclaration(node)) {
            return exportName === "default" ? node : null;
          }

          let { declaration } = node;

          // export const foo = ...;
          if (t.isVariableDeclaration(declaration)) {
            // Only keep identifiers that match the chunked export name
            declaration.declarations = declaration.declarations.filter(
              ({ id }) => {
                if (t.isIdentifier(id)) {
                  return id.name === exportName;
                }

                throw new Error(
                  `Unsupported export identifier type: ${id.type}`
                );
              }
            );

            // If the export statement is now empty, remove it
            if (declaration.declarations.length === 0) {
              return null;
            }

            // Keep the modified AST node
            return node;
          }

          // export function foo() {}
          // export class Foo {}
          if (
            t.isFunctionDeclaration(node.declaration) ||
            t.isClassDeclaration(node.declaration)
          ) {
            // If the function/class name matches the export name, keep the
            // node, otherwise remove it.
            return node.declaration.id?.name === exportName ? node : null;
          }

          // export { foo, bar }
          if (t.isExportNamedDeclaration(node)) {
            // export {}
            // Remove empty export statements within chunks
            if (node.specifiers.length === 0) {
              return null;
            }

            // Only keep specifiers for the chunked export
            node.specifiers = node.specifiers.filter(
              (specifier) => getExportedName(specifier.exported) === exportName
            );

            // If the export statement is now empty, remove it
            if (node.specifiers.length === 0) {
              return null;
            }

            // Keep the modified AST node
            return node;
          }

          // This should never happen:
          // @ts-expect-error: We've handled all the export types
          throw new Error(`Unknown export node type: ${node.type}`);
        })
        .filter((node): node is NonNullable<typeof node> => node !== null);

      return generate(ast, generateOptions);
    }
  );
}

export function omitChunkedExports(
  code: string,
  exportNames: readonly string[],
  generateOptions: GeneratorOptions = {},
  cache: Cache,
  cacheKey: string
): GeneratorResult | undefined {
  return getOrSetFromCache(
    cache,
    `${cacheKey}::omitChunkedExports::${exportNames.join(
      ","
    )}::${JSON.stringify(generateOptions)}`,
    code,
    () => {
      let exportDependencies = getExportDependencies(code, cache, cacheKey);
      let omittedStatements = new Set<Statement>();

      for (let exportName of exportNames) {
        let dependencies = exportDependencies.get(exportName);

        // If the export is not chunkable then its code will still remain in the
        // main chunk, so we need to keep its top level statements.
        if (
          !dependencies ||
          !hasChunkableExport(code, exportName, cache, cacheKey)
        ) {
          continue;
        }

        // Now that we know the export is chunkable, add all of its top level
        // non-module statements to the set of statements to be omitted from the
        // main chunk. Note that we don't include top level module statements in
        // this step because we perform more fine-grained filtering of module
        // statements below.
        for (let statement of dependencies.topLevelNonModuleStatements) {
          omittedStatements.add(statement);
        }
      }

      let ast = codeToAst(code, cache, cacheKey);
      let omittedStatementsArray = Array.from(omittedStatements);

      function isChunkable(exportName: string): boolean {
        return hasChunkableExport(code, exportName, cache, cacheKey);
      }

      function isOmitted(exportName: string): boolean {
        return exportNames.includes(exportName) && isChunkable(exportName);
      }

      ast.program.body = ast.program.body
        // Remove top level statements that belong solely to the chunked
        // exports that are being omitted.
        .filter((node) =>
          omittedStatementsArray.every(
            (statement) => !t.isNodesEquivalent(node, statement)
          )
        )
        // Remove unused imports.
        .map((node): Statement | null => {
          // Skip non-import nodes for this step, return node as-is
          if (!t.isImportDeclaration(node)) {
            return node;
          }

          // If there are no specifiers, this is a side effect import. Side
          // effects implicitly belong to the main chunk, so we leave them.
          if (node.specifiers.length === 0) {
            return node;
          }

          // Remove import specifiers that are only used by the omitted chunks.
          // This ensures only the necessary imports remain in the main chunk.
          node.specifiers = node.specifiers.filter((specifier) => {
            // Check the imported identifiers that each export depends on to see
            // if it includes the specifier's local name.
            for (let exportName of exportNames) {
              // If the export is not chunkable then its code will still remain
              // in the main chunk, so we need to keep its imports.
              if (!isChunkable(exportName)) {
                continue;
              }

              let importedIdentifierNames =
                exportDependencies.get(exportName)?.importedIdentifierNames;

              // If the import specifier's local name is in the set of imported
              // identifiers for the chunked export, we filter it out.
              if (importedIdentifierNames?.has(specifier.local.name)) {
                return false;
              }
            }

            // If we didn't return false, the specifier is not in the set of
            // imported identifiers for any chunked export, so we keep it.
            return true;
          });

          // If the import statement is now empty, remove it
          if (node.specifiers.length === 0) {
            return null;
          }

          // Keep the modified AST node
          return node;
        })
        // Filter out omitted exports and remove unused identifiers
        .map((node): Statement | null => {
          // Skip non-export nodes for this step, return node as-is
          if (!t.isExportDeclaration(node)) {
            return node;
          }

          // The main chunk should include all "export *" declarations
          if (t.isExportAllDeclaration(node)) {
            return node;
          }

          // export default ...;
          if (t.isExportDefaultDeclaration(node)) {
            return isOmitted("default") ? null : node;
          }

          // export const foo = ...;
          if (t.isVariableDeclaration(node.declaration)) {
            // Remove any omitted identifiers
            node.declaration.declarations =
              node.declaration.declarations.filter(({ id }) => {
                if (t.isIdentifier(id)) {
                  return !isOmitted(id.name);
                }

                throw new Error(
                  `Unsupported export identifier type: ${id.type}`
                );
              });

            // If the export statement is now empty, remove it
            if (node.declaration.declarations.length === 0) {
              return null;
            }

            // Keep the modified AST node
            return node;
          }

          // export function foo() {}
          // export class foo {}
          if (
            t.isFunctionDeclaration(node.declaration) ||
            t.isClassDeclaration(node.declaration)
          ) {
            invariant(
              node.declaration.id,
              "Expected exported function or class declaration to have a name when not the default export"
            );
            return isOmitted(node.declaration.id.name) ? null : node;
          }

          // export { foo, bar }
          if (t.isExportNamedDeclaration(node)) {
            // export {}
            // Keep empty export statements in main chunk
            if (node.specifiers.length === 0) {
              return node;
            }

            // Remove omitted export specifiers
            node.specifiers = node.specifiers.filter((specifier) => {
              const exportedName = getExportedName(specifier.exported);
              return !isOmitted(exportedName);
            });

            // If the export statement is now empty, remove it
            if (node.specifiers.length === 0) {
              return null;
            }

            // Keep the modified AST node
            return node;
          }

          // This should never happen:
          // @ts-expect-error: We've handled all the export types
          throw new Error(`Unknown node type: ${node.type}`);
        })
        // Filter out statements that were entirely omitted above.
        .filter((node): node is NonNullable<typeof node> => node !== null);

      if (ast.program.body.length === 0) {
        return undefined;
      }

      return generate(ast, generateOptions);
    }
  );
}

export function detectRouteChunks(
  code: string,
  cache: Cache,
  cacheKey: string
): {
  hasClientActionChunk: boolean;
  hasClientLoaderChunk: boolean;
  hasRouteChunks: boolean;
} {
  let hasClientActionChunk = hasChunkableExport(
    code,
    "clientAction",
    cache,
    cacheKey
  );
  let hasClientLoaderChunk = hasChunkableExport(
    code,
    "clientLoader",
    cache,
    cacheKey
  );
  let hasRouteChunks = hasClientActionChunk || hasClientLoaderChunk;

  return {
    hasClientActionChunk,
    hasClientLoaderChunk,
    hasRouteChunks,
  };
}

const mainChunkName = "main" as const;
const chunkedExportNames = ["clientAction", "clientLoader"] as const;
export type RouteChunkName =
  | typeof mainChunkName
  | (typeof chunkedExportNames)[number];

export function isRouteChunkName(name: string): name is RouteChunkName {
  return name === mainChunkName || chunkedExportNames.includes(name as any);
}

export function getRouteChunk(
  code: string,
  chunkName: RouteChunkName,
  cache: Cache,
  cacheKey: string
): GeneratorResult | undefined {
  if (chunkName === mainChunkName) {
    return omitChunkedExports(code, chunkedExportNames, {}, cache, cacheKey);
  }

  return getChunkedExport(code, chunkName, {}, cache, cacheKey);
}