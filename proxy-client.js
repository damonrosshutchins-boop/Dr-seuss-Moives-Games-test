// Intended for the Render-hosted instance of this repository.
// The service worker and Scramjet assets MUST be served from the same origin as this page.
let controller,frame;
const loadScript=src=>new Promise((resolve,reject)=>{
 const script=document.createElement("script");script.src=src;script.onload=resolve;
 script.onerror=()=>reject(Error("Could not load "+src));document.head.append(script);
});
export async function openProxied(iframe,url){
 if(location.hostname.endsWith(".github.io"))throw Error("Scramjet must run on the Render-hosted application, not the GitHub Pages copy.");
 const allowed=new Set(["wasm.rip","shuttletv.pk"]);
 const u=new URL(url);
 if(u.protocol!=="https:"||![...allowed].some(h=>u.hostname===h||u.hostname.endsWith("."+h)))throw Error("Only the curated games/movie destinations are supported.");
 if(!controller){
  const registration=await navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"});
  await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true}));
  const serviceworker=navigator.serviceWorker.controller??registration.active;
  if(!serviceworker)throw Error("Service worker was not activated");
  for(const src of ["/scram/scramjet.js","/controller/controller.api.js","/utils/scramjet-utils.js"])await loadScript(src);
  const {default:LibcurlClient}=await import("/libcurl/index.mjs");
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  const transport=new LibcurlClient({wisp:protocol+"//"+location.host+"/wisp/"});
  controller=new window.$scramjetController.Controller({serviceworker,transport,config:{scramjetPath:"/scram/scramjet.js",wasmPath:"/scram/scramjet.wasm",injectPath:"/controller/controller.inject.js"}});
  await controller.wait();
  setInterval(()=>navigator.serviceWorker.controller?.postMessage("keepalive"),15000);
 }
 frame=controller.createFrame(iframe);frame.go(u.href);
}
