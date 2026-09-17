'use strict';
document.querySelector('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.target.querySelector('button'),status=document.querySelector('#login-status');
  button.disabled=true;status.textContent='Signing in…';
  try {
    const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({password:event.target.password.value})});
    const data=await response.json();
    if(!response.ok) throw Error(data.error||'Sign-in failed.');
    event.target.password.value='';location.replace('/');
  } catch(error) {status.textContent=error.message;button.disabled=false;}
});
