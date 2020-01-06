// Generate symbols list
// Generate header file
import * as fs from 'fs'
const HEADER_FILE_PATH = process.env.HEADER_FILE_PATH || './c/interface.c'
const INCLUDE_RE = /^#include.*$/gm
const DECL_RE = /^([\w*]+[\s*]+)(QTS_\w+)(\((.*?)\)) ?{$/gm

function main() {
  const headerFile = fs.readFileSync(HEADER_FILE_PATH, 'utf-8')
  const matches = matchAll(DECL_RE, headerFile)
  const includeMatches = matchAll(INCLUDE_RE, headerFile)

  if (process.argv.includes('symbols')) {
    const symbols = matches.map(match => {
      const name = match[2]
      return `_${name}`
    })
    console.log(JSON.stringify(symbols))
  }

  if (process.argv.includes('header')) {
    for (const include of includeMatches) {
      console.log(include[0])
    }
    for (const match of matches) {
      const returnType = match[1]
      const name = match[2]
      const params = match[3]
      console.log(`${returnType}${name}${params};`)
    }
  }

  if (process.argv.includes('ffi')) {
    buildFFI(matches)
  }
}

function cTypeToTypescriptType(ctype: string) {
  // simplify
  let type = ctype
  // remove const: ignored in JS
  type = ctype.replace(/\bconst\b/, '').trim()
  // collapse spaces (around a *, maybe)
  type = type.split(' ').join('')

  // mapping
  if (type.includes('char*')) {
    return { ffi: 'string', typescript: 'string', ctype }
  }

  let typescript = 'C.' + type.replace('*', 'Pointer')
  let ffi: string | null = 'number'

  if (type === 'void') { ffi = null }
  if (type.includes('*')) { ffi = 'number' }

  return { typescript, ffi, ctype }
}


function buildFFI(matches: RegExpExecArray[]) {
  const parsed = matches.map(match => {
    const [
      ,
      returnType,
      functionName,
      ,
      rawParams,
    ] = match
    const params = parseParams(rawParams)
    return { functionName, returnType: cTypeToTypescriptType(returnType.trim()), params }
  })
  const decls = parsed.map(fn => {
    const typescriptParams = fn.params.map(param => `${param.name}: ${param.type.typescript}`).join(', ')
    const typescriptFnType = `(${typescriptParams}) => ${fn.returnType.typescript}`
    const ffiParams = JSON.stringify(fn.params.map(param => param.type.ffi))
    const cwrap = `this.module.cwrap(${JSON.stringify(fn.functionName)}, ${JSON.stringify(fn.returnType.ffi)}, ${ffiParams})`
    return `  ${fn.functionName}: ${typescriptFnType} =\n    ${cwrap}`
  })
  const classString = `
// This file generated by "generate.ts ffi" in the root of the repo.

import * as C from './ffi-types'

/**
 * Low-level FFI bindings to QuickJS's Emscripten module
 */
export class QuickJSFFI {
  constructor(private module: EmscriptenModule) {}

${decls.join("\n\n")}
}
  `.trim()
  console.log(classString)
}

function parseParams(paramListString: string) {
  if (paramListString.trim().length === 0) {
    return []
  }
  const params = paramListString.split(',')
  return params.map(paramString => {
    const lastWord = /\b\w+$/
    const name = paramString.match(lastWord)
    const type = paramString.replace(lastWord, '').trim()
    return { name: name ? name[0] : '', type: cTypeToTypescriptType(type) }
  })
}

function matchAll(regexp: RegExp, text: string) {
	// We're using .exec, which mutates the regexp by setting the .lastIndex
	const initialLastIndex = regexp.lastIndex
  const result: RegExpExecArray[] = []
	let match  = null
	while ((match = regexp.exec(text)) !== null) {
		result.push(match)
	}
	regexp.lastIndex = initialLastIndex
	return result
}

main()
