import fs from "node:fs/promises";
import path from "node:path";

// Build-time routing audit. Checks that catalogue links cannot accidentally
// bypass the restricted proxy, and that local launchers were actually built.
// This is not a browser gameplay test or a remote-server availability test.
const [html, client, server] = await Promise.all([
  fs.readFile("index.html","utf8"),
  fs.readFile("proxy-client.js","utf8"),
  fs.readFile("server.mjs","utf8")
]);
const site="https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/";
const base="/Dr-seuss-Moives-Games-test/";
const rows=html.split(/\r?\n/).filter(row=>row.startsWith("{id:'"));
const errors=[];
if(rows.length<9)errors.push("Arcade catalogue entries could not be parsed");
const allowedMatch=client.match(/const allowed = new Set\(\[([^\]]+)\]\)/);
if(!allowedMatch)errors.push("Restricted proxy host allowlist not found");
const allowed=new Set((allowedMatch?.[1]||"").split(",").map(v=>v.trim().replace(/^"|"$/g,"")));
const approved=new Set(
  [...client.matchAll(/"https:\/\/[^"]+"/g)].map(match=>match[0].slice(1,-1))
);
const entries=rows.map(line=>({
  id:line.match(/^\{id:'([^']+)'/)?.[1],
  url:line.match(/url:'([^']+)'/)?.[1],
  local:line.includes("local:true"),
  isolated:line.includes("needsIsolation:true")
}));
let localCount=0,remoteCount=0,isolatedCount=0;
for(const entry of entries){
  if(!entry.id||!entry.url){errors.push("Unrecognized catalogue row: "+JSON.stringify(entry));continue;}
  let url;
  try{url=new URL(entry.url,site);}catch{errors.push("Invalid URL for "+entry.id);continue;}
  if(entry.local){
    localCount++;
    if(entry.isolated)isolatedCount++;
    if(url.origin!==new URL(site).origin||!url.pathname.startsWith(base))
      errors.push(entry.id+": local launcher points off-site");
    else{
      const relative=decodeURIComponent(url.pathname.slice(base.length));
      const dest=path.resolve("dist",relative);
      const root=path.resolve("dist")+path.sep;
      if(!dest.startsWith(root))errors.push(entry.id+": launcher path escapes dist");
      else{
        try{if(!(await fs.stat(dest)).isFile())errors.push(entry.id+": launcher is not a file");}
        catch{errors.push(entry.id+": built launcher missing at "+relative);}
      }
    }
  }else{
    remoteCount++;
    const host=url.hostname.toLowerCase();
    if(url.protocol!=="https:" ||
       ![...allowed].some(candidate=>host===candidate||host.endsWith("."+candidate)))
      errors.push(entry.id+": remote destination is not on proxy host allowlist");
    if(host!=="wasm.rip"&&host!=="shuttletv.pk"&&!approved.has(url.href))
      errors.push(entry.id+": missing exact approved proxy entry");
  }
}
for(const [label,source,required] of [
  ["Viewer restricted remote launcher",html,["await openProxied(frame,x.url","frame.src=path.href","location.assign(localUrl.href)","if(path.origin!==location.origin)"]],
  ["Scramjet restricted Wisp client",client,["controller.createFrame(iframe)","frame.go(target.href)","wss://seuss-cinema-arcade.onrender.com/wisp/","Only approved games and movie destinations"]],
  ["Render Wisp policy",server,["wisp.options.hostname_whitelist=","wisp.options.allow_private_ips=false","wisp.options.allow_direct_ip=false","const allowedOrigin=new Set","function approvedGameCors"]],
  ["Pinned game routes",server,["tungobby/Build/TungTungSahur-ObbyChallenge-v.1.1.framework.js.unityweb","zelda-oot/rom.n64.part1","centipede/rom.zip","run2/Run2.swf","run2/ruffle.js","run2/4d882486fa9bfce731b9.wasm","run2/f7f28eb60b84863611ca.wasm"]]
]){
  for(const snippet of required)if(!source.includes(snippet))errors.push(label+": missing "+snippet);
}
if(errors.length){
  for(const error of errors)console.error("ROUTING CHECK FAILED:",error);
  process.exitCode=1;
}else{
  console.log("Routing audit passed: "+entries.length+" entries ("+localCount+" local, "+remoteCount+" via restricted Wisp, "+isolatedCount+" same-origin top-level isolation exceptions).");
  console.log("This checks routing and published files, not emulator gameplay or third-party asset availability.");
}
