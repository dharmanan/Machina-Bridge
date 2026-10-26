// CI safety check: parse declarations, never interpret source text through a shell-escaped regular expression.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
export const BORROW_SOURCE_GATES = ['MAINNET_BORROW_WRITES_ENABLED', 'MAINNET_BORROW_EXECUTION_BOUND']
export function assertBorrowSourceGates(source) {
  const file = ts.createSourceFile('mainnetBorrow.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal(file.parseDiagnostics.length, 0, 'Borrow gate source must parse without errors')
  for (const name of BORROW_SOURCE_GATES) {
    const found = []
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) found.push({ statement, declaration })
      }
    }
    assert.equal(found.length, 1, `${name} must have exactly one top-level declaration`)
    const { statement, declaration } = found[0]
    assert.ok(statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), `${name} must be exported`)
    assert.ok(statement.declarationList.flags & ts.NodeFlags.Const, `${name} must be const`)
    assert.equal(declaration.initializer?.kind, ts.SyntaxKind.FalseKeyword, `${name} must be initialized with literal false`)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBorrowSourceGates(readFileSync(new URL('../src/config/mainnetBorrow.ts', import.meta.url), 'utf8'))
  console.log('PASS both Borrow source gates are exported const literal false (TypeScript AST)')
}
