// Push-only service worker. Private pages, API responses and clips are not cached.
self.addEventListener('push',event=>{
  let data;
  try{data=event.data?.json();}catch{return;}
  if(!data?.title)return;
  event.waitUntil(self.registration.showNotification(String(data.title).slice(0,120),{
    body:String(data.body||'').slice(0,240),tag:String(data.tag||'roadwatch'),renotify:false,
    data:{url:typeof data.url==='string'?data.url:'/'},
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  let target=new URL(event.notification.data?.url||'/',self.location.origin);
  if(target.origin!==self.location.origin)target=new URL('/',self.location.origin);
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
    if(existing){await existing.navigate(target.href);return existing.focus();}
    return self.clients.openWindow(target.href);
  })());
});
