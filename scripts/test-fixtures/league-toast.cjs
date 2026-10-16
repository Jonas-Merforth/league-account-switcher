const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const statePath=path.join(process.argv[2],'state.json');
const mode=process.argv.find(x=>x.startsWith('--case='))?.split('=')[1]||'positive';
app.setPath('userData',path.join(process.argv[2],'profile'));
app.whenReady().then(async()=>{
 app.setAccessibilitySupportEnabled(false);
 const window=new BrowserWindow({width:520,height:320,show:false,webPreferences:{preload:path.join(__dirname,'league-toast-preload.cjs')}});
 ipcMain.on('fixture:state',(_event,state)=>fs.writeFileSync(statePath,JSON.stringify({mode,...state})));
 const html=`<!doctype html><html><head><title>League toast cleanup fixture</title><style>body{background:#24303b;color:white;font:16px sans-serif;padding:20px}.close{background:#8b3741;padding:12px;width:150px;margin:12px;cursor:pointer}</style></head><body><h3>Notification cleanup test</h3><p id="page">Original page</p><div id="decoy" class="lol-uikit-dialog-frame-toast-close-button close">Decoy close</div><div id="layer" class="${mode==='wrong-parent'?'unrelated-layer':'lol-uikit-toast-celebration-layer'}"><fixture-toast></fixture-toast>${mode==='duplicate'?'<fixture-toast></fixture-toast>':''}</div><script>
 const state={toastDismissed:false,decoyClicked:false,page:'Original page'};
 document.getElementById('decoy').onclick=()=>{state.decoyClicked=true;window.fixture.report(state)};
 class Toast extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:'open'});root.innerHTML='<style>.close{background:#276e50;padding:12px;margin:12px;cursor:pointer}</style><p>Fixture toast</p><div class="lol-uikit-dialog-frame-toast-close-button close" ${mode==='hidden'?'style="display:none"':''}>Toast close</div>';root.querySelector('.close').onclick=()=>{state.toastDismissed=true;document.getElementById('layer').remove();window.fixture.report(state)}}}
 customElements.define('fixture-toast',Toast);window.fixture.report(state);
 </script></body></html>`;
 await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 window.showInactive();
 app.setAccessibilitySupportEnabled(false);
 fs.writeFileSync(path.join(process.argv[2],'ready.json'),JSON.stringify({accessibilityEnabled:app.accessibilitySupportEnabled}));
 setTimeout(()=>app.quit(),30000);
});
