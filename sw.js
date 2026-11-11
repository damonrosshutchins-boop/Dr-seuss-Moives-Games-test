// Works under both the Render root and a GitHub Pages project path.
const prefix=new URL("./",self.location.href).pathname;
importScripts(prefix+"controller/controller.sw.js");
self.addEventListener("fetch",event=>{
 if($scramjetController.shouldRoute(event))event.respondWith($scramjetController.route(event));
});
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
