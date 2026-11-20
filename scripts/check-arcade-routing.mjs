import fs from "node:fs/promises";
import path from "node:path";

// Build-time routing audit. Checks that catalogue links cannot accidentally
// bypass the restricted proxy, that local launchers were actually built, and
// that nothing still points at the retired Render service.
// This is not a browser gameplay test or a remote-server availability test.
const [html, client, arcadeWorker, searchPage, searchClient] = await Promise.all([
  fs.readFile("index.html","utf8"),
  fs.readFile("proxy-client.js","utf8"),
  fs.readFile("cloudflare/arcade/worker.mjs","utf8"),
  fs.readFile("seuss-search.html","utf8"),
  fs.readFile("search-client.js","utf8")
]);
const site="https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/";
const base="/Dr-seuss-Moives-Games-test/";
const rows=html.split(/\r?\n/).filter(row=>row.startsWith("{id:'"));
const errors=[];
// The whole catalogue lives in one inline script. A stray comma there leaves the
// live page with no cards while every row-parsing check above still passes.
for(const script of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)){
  if(/type\s*=\s*"module"/.test(script[1])||!script[2].trim())continue;
  try{new Function(script[2]);}
  catch(error){errors.push("Arcade inline script does not parse: "+error.message);}
}
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
  direct:line.includes("direct:true"),
  isolated:line.includes("needsIsolation:true")
}));
let localCount=0,remoteCount=0,isolatedCount=0,directCount=0;
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
    // Cloudflare-held hosts refuse the relay's TCP sockets, so those approved
    // pages load their pinned URL in the frame instead of through the proxy.
    if(entry.direct)directCount++; else remoteCount++;
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
  ["Scramjet restricted Wisp client",client,["controller.createFrame(iframe)","frame.go(target.href)","wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/","Only approved games and movie destinations"]],
  ["Cloudflare relay policy",arcadeWorker,["isPrivateHost","connect({ hostname: host, port })","function denyOrigin","ALLOW_PRIVATE_IPS","const SELF_ORIGIN"]],
  ["Seuss Search v2 client",searchClient,["wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/","frame.go(target.href)","www.bing.com/search?q=","Only http and https pages"]],
  ["Seuss Search v2 page",searchPage,["id=\"field\"","id=\"searchForm\"","id=\"bgOpts\"","id=\"relayOpts\"","id=\"toLibrary\"","search-client.js"]],
  ["Seuss Search relay choice",searchClient,["readRelay","writeRelay","seuss-relay","wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/"]],
  ["Cloudflare relay worker",arcadeWorker,["cloudflare:sockets","class WispRelay","wisp-1","ALLOW_PRIVATE_IPS"]],
  ["Pinned game routes",arcadeWorker,["zelda-oot/rom.n64.part1","centipede/rom.zip","run2/Run2.swf","run2/ruffle.js","run2/4d882486fa9bfce731b9.wasm","run2/f7f28eb60b84863611ca.wasm","uwuclient/cluwuclient.html.part1","uwuclient/cluwuclient.html.part2","/approved-games/uwu-client/index.html","tomb-mask/UnityLoader.js","tomb-mask/totm.json","tomb-mask/totm.data.unityweb","tomb-mask/totm.wasm.code.unityweb","tomb-mask/totm.wasm.framework.unityweb","snow-rider/Build/UnityLoader.js","snow-rider/Build/SnowRider3D-gd-1.json","snow-rider/Build/SnowRider3D-gd-1.data.unityweb","snow-rider/Build/SnowRider3D-gd-1.wasm.code.unityweb","snow-rider/Build/SnowRider3D-gd-1.wasm.framework.unityweb.js","btd6Commit","gartenCommit","gartenFiles","/approved-assets/garten/","a82c94ea3e9a2f2cbc2e1d925007947134b4f156","repoHalloweenCommit","approvedRepoHalloweenFile","/approved-assets/repo-halloween/","edd5e11fae76bfe8966633f19a6e43935874a8b4","approvedBtd6Asset","/approved-assets/btd6/","9546494b3052e8e078fb28df7430ac35f42a8787"]],
  ["1v1.LOL pinned Unity route",arcadeWorker,["oneVOneCommit","af28b6e4c6ac08827a3404d33defd626cd236f74","n-101-1/1@","/approved-assets/imported/1v1/","new URL(file, base)"]],
  ["1v1.LOL Firebase relay",arcadeWorker,["FIREBASE_ROUTE","firebaseUpstreams","identitytoolkit","securetoken.googleapis.com","firestore.googleapis.com","serve11FirebaseSdk","handleFirebaseRelay","firebaseSdkAssets"]],
  ["Gamble With Your Friends pinned Cloudflare route",arcadeWorker,["gambleCommit","d7b3ac61ce6d2cb98e212dfa01ba0df413539a53","Camzzz-vrgt/gamble-with-your-friends-web","approvedGambleFile","gambleRoute"]],
  ["Buckshot pinned Cloudflare route",arcadeWorker,["buckshotCommit","f8a263b4da11c181e02e31086e5a5c8bc2dd1457","Random-Red-Dude-809-4456/buckshot","approvedBuckshotFile","buckshotRoute"]],
  ["Pinned Unity mirrors",arcadeWorker,["unityMirrors","approvedUnityMirrorFile","d4ce675e5ab1bddd8ef03994129d31a8c8b34c67","eb5348fe5a0f17956daaea873fb161c7142ed0a7","a8815a5edf746b24ebd8028273c4de80c8f67821","79306ef07b5456ebdc6d25dc023aa61184c1ae27","631e27caca8f082cd60c8d374f7a7a96d422e26f"]],
  ["Firebase endpoint lock",arcadeWorker,["firebaseIdtMethods","approvedFirebaseTarget","FIREBASE_FIRESTORE_PREFIX"]],
  ["Happy Wheels mirror",arcadeWorker,["HW_ROUTE","HW_ASSET_ROOT","80b52b89d6e2739e79378ef2512cd86e2ef79c7c","happyWheelsHtml","serveHappyWheelsApi","serveHappyWheelsBackendConfig","HW_CONFIG_ORIGIN"]],
  ["Dispatch mirror",arcadeWorker,["DISPATCH_ROUTE","DISPATCH_LFS_ROOT","dispatchHtml","media.githubusercontent.com"]],
  ["Find The Needle mirror",arcadeWorker,["NEEDLE_ROUTE","archivedGames","archivedGameFile","FindTheNeedle"]],
  ["Projection Studios movie mirror",arcadeWorker,["MOVIE_ROUTE","MOVIE_ORIGIN","serveMovieApp","serveMovieSocket","movieRewrite","projection-studios.dogeeats531.workers.dev"]],
  ["Toby Web mirror",arcadeWorker,["TOBY_ROUTE","TOBY_ORIGIN","TOBY_API_ORIGIN","serveToby","tobyRewrite","themes-api.booksforschool.online"]],
  ["2v2.io mirror with ads blocked",arcadeWorker,["TWOV2_ROUTE","TWOV2_ORIGIN","serveTwoVTwo","twoVTwoRewrite","TWOV2_AD_BLOCK","content-security-policy"]]
]){
  for(const snippet of required)if(!source.includes(snippet))errors.push(label+": missing "+snippet);
}
// Every game now loads through the Cloudflare Worker; the Render service is gone.
for(const [label,source] of [["arcade page",html],["player client",client],["search page",searchPage],["search client",searchClient]]){
  if(/onrender\.com/.test(source))errors.push(label+": still points at the retired Render service");
}
for(const name of await fs.readdir("games")){
  const file=path.join("games",name,"index.html");
  let source;
  try{source=await fs.readFile(file,"utf8");}catch{continue;}
  if(/onrender\.com/.test(source))errors.push(file+": still points at the retired Render service");
}
// No launcher may bypass the Worker: every game file comes from the relay, a
// same-site path, or nothing at all.
const directHost=/https?:\/\/(?:cdn\.jsdelivr\.net|cdn\.emulatorjs\.org|fonts\.googleapis\.com|raw\.githubusercontent\.com|www\.googleapis\.com|firestore\.googleapis\.com|securetoken\.googleapis\.com)/;
for(const name of await fs.readdir("games")){
  const file=path.join("games",name,"index.html");
  let source;
  try{source=await fs.readFile(file,"utf8");}catch{continue;}
  const hit=source.match(directHost);
  if(hit)errors.push(file+": still loads "+hit[0]+" directly instead of through the Worker");
}
if(errors.length){
  for(const error of errors)console.error("ROUTING CHECK FAILED:",error);
  process.exitCode=1;
}else{
  console.log("Routing audit passed: "+entries.length+" entries ("+localCount+" local, "+remoteCount+" via restricted Wisp, "+directCount+" direct Cloudflare-hosted pages, "+isolatedCount+" same-origin top-level isolation exceptions).");
  console.log("Every proxied game asset route resolves to the Cloudflare Worker; no Render host remains.");
  if(directCount)console.log(directCount+" entries load their pinned page directly because Cloudflare refuses the relay's sockets to its own addresses, or because the relay mirrors the site itself.");
  console.log("This checks routing and published files, not emulator gameplay or third-party asset availability.");
}
