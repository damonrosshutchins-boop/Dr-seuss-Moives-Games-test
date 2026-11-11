import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {scramjetPath} from "@mercuryworkshop/scramjet/path";
const require=createRequire(import.meta.url);
const out="dist";
await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
for(const f of ["index.html","proxy-client.js","sw.js"])await fs.copyFile(f,path.join(out,f));
const dirs=[
 ["scram",scramjetPath],
 ...[
 ["controller","@mercuryworkshop/scramjet-controller"],
 ["utils","@mercuryworkshop/scramjet-utils"],
 ["libcurl","@mercuryworkshop/libcurl-transport"]
 ].map(([name,pkg])=>[name,path.dirname(require.resolve(pkg))])
];
for(const [name,src] of dirs)await fs.cp(src,path.join(out,name),{recursive:true});
await fs.writeFile(path.join(out,".nojekyll"),"");
console.log("Built GitHub Pages assets into dist/");
