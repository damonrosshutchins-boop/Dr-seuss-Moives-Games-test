// GitHub Pages hosts Scramjet's service worker; Render hosts the Wisp relay.
// All destination requests made through this controller use the Render transport.
let controller,frame;
const base=new URL("./",import.meta.url).pathname;
const asset=p=>base+p;
const loadScript=src=>new Promise((resolve,reject)=>{
 const script=document.createElement("script");script.src=src;script.onload=resolve;
 script.onerror=()=>reject(Error("Could not load "+src));document.head.append(script);
});
export async function openProxied(iframe,url){
 
 const allowed=new Set(["wasm.rip","shuttletv.pk"]);
 const u=new URL(url);
 if(u.protocol!=="https:"||![...allowed].some(h=>u.hostname===h||u.hostname.endsWith("."+h)))throw Error("Only the curated games/movie destinations are supported.");
 if(!controller){
  const registration=await navigator.serviceWorker.register(asset("sw.js"),{scope:base,updateViaCache:"none"});
  await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true}));
  const serviceworker=navigator.serviceWorker.controller??registration.active;
  if(!serviceworker)throw Error("Service worker was not activated");
  for(const src of [asset("scram/scramjet.js"),asset("controller/controller.api.js"),asset("utils/scramjet-utils.js")])await loadScript(src);
  const {default:LibcurlClient}=await import(asset("libcurl/index.mjs"));
  // Fixed relay: never silently fall back to direct requests or another proxy.
  const endpoint="wss://seuss-cinema-arcade.onrender.com/wisp/";
  const transport=new LibcurlClient({wisp:endpoint});
  controller=new window.$scramjetController.Controller({serviceworker,transport,config:{scramjetPath:asset("scram/scramjet.js"),wasmPath:asset("scram/scramjet.wasm"),injectPath:asset("controller/controller.inject.js"),prefix:base+"scramjet/"}});
  await controller.wait();
  setInterval(()=>navigator.serviceWorker.controller?.postMessage("keepalive"),15000);
 }
 frame=controller.createFrame(iframe);frame.go(u.href);
}
