// Network only: never cache the dashboard, API, exports or journal responses.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.mode!=='navigate') return;
  event.respondWith(fetch(event.request,{cache:'no-store'}).catch(()=>new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Offline</title><h1>You are offline.</h1><p>Reconnect to open your private training journal.</p></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));
});
