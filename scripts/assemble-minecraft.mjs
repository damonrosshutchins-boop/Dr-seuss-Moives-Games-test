import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Exact UTF-8 bytes of the user's standalone Horizon build after replacing
// its sound URLs with the fixed restricted Render route and adding Back link.
const EXPECTED_SHA256="163042344cbf87c0b7bc22096b8f6b8d5a0b5ee93dd053df41a5d7fc91f64e0e";
const EXPECTED_BYTES=45606278;
const partsFolder=fileURLToPath(new URL("../games/minecraft-26.3/chunks/",import.meta.url));
const destination=path.resolve(process.argv[2]||"games/minecraft-26.3/index.html");
const chunks=[];
for(let i=0;i<23;i++){
 const chunkName="part-"+String(i).padStart(2,"0")+".txt";
 const bytes=await fs.readFile(path.join(partsFolder,chunkName));
 chunks.push(bytes);
}
const complete=Buffer.concat(chunks);
const digest=createHash("sha256").update(complete).digest("hex");
if(complete.length!==EXPECTED_BYTES||digest!==EXPECTED_SHA256){
 throw new Error("Minecraft bundle failed integrity check: "+complete.length+" bytes, "+digest);
}
await fs.mkdir(path.dirname(destination),{recursive:true});
await fs.writeFile(destination,complete);
console.log("Minecraft 26.3 single-file Horizon bundle assembled: "+complete.length+" bytes -> "+destination);
