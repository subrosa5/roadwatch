export function configurePush({button,status,request,hosted}) {
  const say = value => {status.textContent=value;};
  const decode = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  button.addEventListener('click',async()=>{
    if(!hosted())return say('Push доступен в приватной облачной консоли.');
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return say('В этом браузере Web Push недоступен. Журнал событий продолжает работать.');
    button.disabled=true;
    try {
      const old=await navigator.serviceWorker.getRegistration('./');
      const existing=await old?.pushManager.getSubscription();
      if(existing && button.dataset.enabled==='1') {
        await request('/api/push/subscription',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(existing)});
        await existing.unsubscribe();button.dataset.enabled='0';button.textContent='Включить push';say('Уведомления отключены на этом устройстве.');return;
      }
      const permission=await Notification.requestPermission();
      if(permission!=='granted')return say('Разрешение не выдано. Изменить его можно в настройках браузера.');
      const settings=await(await request('/api/push/settings')).json();
      await navigator.serviceWorker.register('./sw.js',{scope:'./'});
      const registration=await navigator.serviceWorker.ready;
      let sub=await registration.pushManager.getSubscription();
      const expected=decode(settings.public_key);
      if(sub && (!sub.options.applicationServerKey || Array.from(new Uint8Array(sub.options.applicationServerKey)).join(',')!==Array.from(expected).join(','))){await sub.unsubscribe();sub=null;}
      sub ||= await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:expected});
      await request('/api/push/subscription',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
      button.dataset.enabled='1';button.textContent='Отключить push';say('Устройство подписано. Доставка требует работающего облачного коллектора и поддержки браузера.');
    }catch{say('Не удалось сохранить подписку. Проверь соединение и настройки уведомлений браузера.');}
    finally{button.disabled=false;}
  });
  if('Notification' in window && Notification.permission==='denied')say('Уведомления запрещены в настройках браузера.');
  setTimeout(async()=>{
    if(!hosted()||button.disabled||!('Notification' in window)||Notification.permission!=='granted'||!('serviceWorker' in navigator))return;
    try{const registration=await navigator.serviceWorker.getRegistration('./');const existing=await registration?.pushManager.getSubscription();if(existing){button.dataset.enabled='1';button.textContent='Отключить push';say('В браузере сохранена подписка на это устройство.');}}catch{}
  },2000);
}
