const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 600, height: 650, show: false,
    webPreferences: { preload: path.join(__dirname, 'riot-login-preload.cjs') }
  });
  ipcMain.on('fixture:submitted', (_event, result) => {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!doctype html><title>Riot login regression fixture</title>
    <style>body{padding:30px}label,input{display:block}input:not([type=checkbox]){width:300px;height:40px}
    button{display:block;width:70px;height:70px;margin:50px}</style>
    <form><label for="username">USERNAME</label><input id="username" autocomplete="off">
    <label for="password">PASSWORD</label><input id="password" type="password">
    <label><input id="remember" type="checkbox">Stay signed in</label>
    <button disabled>Sign in</button></form><script>
    const user=document.querySelector('#username'), pass=document.querySelector('#password');
    document.addEventListener('input',()=>document.querySelector('button').disabled=!(user.value&&pass.value));
    document.querySelector('form').onsubmit=e=>{e.preventDefault();window.fixture.report({
      usernameMatched:user.value==='fixture-user',passwordMatched:pass.value==='fixture-password',
      remembered:document.querySelector('#remember').checked
    })};</script>`));
  window.showInactive();
  // Start with only native window accessibility, including when an inspector is open elsewhere.
  // The login helper must request web accessibility itself; this fixture never enables it.
  app.setAccessibilitySupportEnabled(false);
  fs.writeFileSync(path.join(directory, 'ready.json'), JSON.stringify({
    accessibilityEnabled: app.accessibilitySupportEnabled
  }));
  setTimeout(() => app.quit(), 40000);
});
