import {readFile} from 'node:fs/promises';

export function flatten(object,prefix='') {
  return Object.fromEntries(Object.entries(object).flatMap(([key,value])=>{
    const path=prefix?`${prefix}.${key}`:key;
    return typeof value==='string'?[[path,value]]:Object.entries(flatten(value,path));
  }));
}
export async function readCatalog(language='en') {
  return flatten(JSON.parse(await readFile(new URL(`../../lang/${language}.json`,import.meta.url),'utf8')));
}
