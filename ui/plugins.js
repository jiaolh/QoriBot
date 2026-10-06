'use strict';
window.QoriPluginUI={pages:new Map(),register(page,hooks){this.pages.set(page,hooks);}};
let pluginSignature='';
async function loadPlugins(){
  const {rows}=await api('/api/plugins'),signature=JSON.stringify(rows);if(signature===pluginSignature)return;pluginSignature=signature;
  $('plugin-list').innerHTML=rows.map(row=>`<article class="card"><div class="card-top"><div><h2>${esc(row.name)} <span class="tag soft">${esc(row.version)}</span></h2><p class="muted">${esc(row.description)}</p></div><label class="toggle-row"><span>${row.enabled?'已启用':'已关闭'}</span><input type="checkbox" role="switch" data-plugin-toggle="${esc(row.id)}" ${row.enabled?'checked':''}></label></div><p class="muted">${!row.enabled?'插件已关闭':row.running?'随机器人运行中':'等待机器人启动'}${row.stats.active!==undefined?` · ${row.stats.active} 条预约启用 · ${row.stats.attention} 条需要查看`:''}</p>${row.page?`<button class="button secondary" data-page="${esc(row.page)}">打开管理 →</button>`:''}</article>`).join('')||'<article class="card">暂无已注册插件。</article>';
}
$('plugin-list').addEventListener('change',guarded(async event=>{
  const control=event.target.closest('[data-plugin-toggle]');if(!control)return;control.disabled=true;
  try{await api('/api/plugins/'+encodeURIComponent(control.dataset.pluginToggle)+'/enabled','POST',{enabled:control.checked});settings=await api('/api/settings');await loadPlugins();notify('插件开关已保存。');}finally{control.disabled=false;}
}));
