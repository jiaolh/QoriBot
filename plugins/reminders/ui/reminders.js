'use strict';
let reminderPage=1,reminderTotal=0,reminderRows=[],reminderTargets=[],reminderRevision=null,reminderSignature='',reminderBusy=false,reminderRequestId='',reminderSearchTimer;
const reminderEditorNode=$('reminder-editor'),reminderEditorHome=$('reminder-editor-home');
const reminderStates={active:'启用',paused:'暂停',sending:'发送中',completed:'已完成',failed:'发送失败',uncertain:'结果未知',cancelled:'已停止（旧记录）',missed:'已错过'};
const reminderRepeats={once:'一次',daily:'每天',weekly:'每周',workdays:'工作日',monthly:'每月',interval:'固定间隔'};
const reminderTime=at=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
function reminderTargetLabel(row){return reminderTargets.find(t=>t.scope===row.scope&&t.targetId===row.targetId)?.label||short(row.targetId);}
function closeReminderEditor(){
  reminderEditorNode.classList.add('hidden');reminderEditorHome.append(reminderEditorNode);$('reminder-edit-row')?.remove();
  $('reminder-rows').querySelectorAll('[data-reminder-action="edit"]').forEach(button=>button.setAttribute('aria-expanded','false'));
  $('reminder-id').value='';reminderRevision=null;
}
function placeReminderEditor(id){
  reminderEditorHome.append(reminderEditorNode);$('reminder-edit-row')?.remove();
  $('reminder-rows').querySelectorAll('[data-reminder-action="edit"]').forEach(button=>button.setAttribute('aria-expanded',String(button.dataset.id===id)));
  if(!id)return;
  const selected=$('reminder-rows').querySelector(`[data-reminder-row="${id}"]`);
  if(!selected){closeReminderEditor();return;}
  const detail=document.createElement('tr');detail.id='reminder-edit-row';detail.className='reminder-edit-row';
  const cell=document.createElement('td');cell.colSpan=5;cell.append(reminderEditorNode);detail.append(cell);selected.after(detail);
}
function reminderTimeFields(){
  const relative=$('reminder-time-type').value==='relative';$('reminder-when').placeholder=relative?'10分钟 或 1小时30分钟':'明天08:00 或 2026-10-07 08:00';
  $('reminder-time-help').textContent=relative?'相对时间从点击保存时计算；重复间隔至少为 1 分钟。':'只填钟点表示下一次该钟点；每月不存在的日期会跳过，不挪到月末。';
  const interval=$('reminder-repeat').value==='interval';$('reminder-interval-field').classList.toggle('hidden',!interval);$('reminder-interval').required=interval;
}
async function loadReminders(){
  const params=new URLSearchParams({page:String(reminderPage),state:$('reminder-state').value,q:$('reminder-search').value.trim()});
  const [result,service]=await Promise.all([api('/api/plugins/reminders/tasks?'+params),api('/api/plugins/reminders')]);
  reminderRows=result.rows;reminderTargets=result.targets;reminderTotal=result.total;
  $('reminder-new').disabled=!service.enabled;$('reminder-service-state').textContent=(!service.enabled?'预约插件已关闭，已有预约保留；请在“插件管理”页启用。':!service.connected?'机器人未连接，预约保留并等待连接。':'预约插件运行中。')+' 到时优先使用最近有效消息回复，没有有效消息时尝试主动发送。送达取决于 QQ 实际权限、频控与接收方设置；失败原因可在记录中查看。';
  const oldTarget=$('reminder-target').value;$('reminder-target').innerHTML='<option value="">选择已发现的私聊或群聊</option>'+reminderTargets.map(t=>`<option value="${esc(t.scope+':'+t.targetId)}">${t.scope==='group'?'群聊':'私聊'} · ${esc(t.label)}</option>`).join('');if(oldTarget)$('reminder-target').value=oldTarget;
  $('reminder-count').textContent=`共 ${result.total} 条 · ${result.stats.active} 条启用 · ${result.stats.attention} 条需要查看`;
  const lastPage=Math.max(1,Math.ceil(result.total/50));if(reminderPage>lastPage){reminderPage=lastPage;return loadReminders();}
  $('reminder-page').textContent=`第 ${reminderPage} / ${Math.max(1,Math.ceil(result.total/50))} 页`;$('reminder-prev').disabled=reminderPage<=1;$('reminder-next').disabled=reminderPage*50>=result.total;
  const signature=JSON.stringify([result.rows,result.targets]);if(signature===reminderSignature)return;reminderSignature=signature;
  const editingId=$('reminder-id').value,editorOpen=!reminderEditorNode.classList.contains('hidden');
  const focused=document.activeElement,selection=focused?.selectionStart!==undefined?[focused.selectionStart,focused.selectionEnd]:null;
  const restoreFocus=editorOpen&&reminderEditorNode.contains(focused);
  // 先移走真实表单再刷新列表，保留正在输入的内容及事件绑定。
  reminderEditorHome.append(reminderEditorNode);
  $('reminder-rows').innerHTML=result.rows.length?result.rows.map(row=>`<tr data-reminder-row="${row.id}"><td><strong class="reminder-content-preview">${esc(row.content)}</strong><small>${row.id}</small>${row.lastError?`<small class="danger">${esc(row.lastError)}</small>`:''}</td><td>${row.scope==='group'?'群聊':'私聊'}<small>${esc(reminderTargetLabel(row))}</small></td><td>${reminderTime(row.nextAt)}<small>北京时间</small></td><td>${reminderRepeats[row.schedule.repeat]}<small>${reminderStates[row.state]} · 已发送 ${row.sendCount} 次</small></td><td><div class="reminder-row-actions"><button class="text-button" data-reminder-action="history" data-id="${row.id}">记录</button>${!['completed','cancelled','sending'].includes(row.state)?`<button class="text-button" data-reminder-action="edit" data-id="${row.id}" aria-controls="reminder-editor" aria-expanded="false">编辑</button>`:''}${row.state==='active'?`<button class="text-button" data-reminder-action="pause" data-id="${row.id}">暂停</button>`:''}${['paused','failed','uncertain','missed'].includes(row.state)?`<button class="text-button" data-reminder-action="resume" data-id="${row.id}">${row.state==='paused'?'恢复':'核对后恢复'}</button>`:''}${row.state!=='sending'?`<button class="text-button danger" data-reminder-action="delete" data-id="${row.id}">删除</button>`:''}</div></td></tr>`).join(''):'<tr><td colspan="5" class="empty-table">暂无预约。可以手动新建，或直接对 Bot 说想在什么时候提醒什么。</td></tr>';
  if(editorOpen&&editingId){
    const current=reminderRows.find(row=>row.id===editingId);
    if(!current||['completed','cancelled','sending'].includes(current.state)){closeReminderEditor();notify('预约已更新或不在当前列表中，编辑已收起。');}
    else placeReminderEditor(editingId);
  }
  if(restoreFocus&&!reminderEditorNode.classList.contains('hidden')){focused.focus({preventScroll:true});if(selection&&selection[0]!==null)focused.setSelectionRange(...selection);}
}
function reminderEditor(row){
  reminderRevision=row?.revision??null;reminderRequestId=crypto.randomUUID();$('reminder-editor').classList.remove('hidden');$('reminder-editor-title').textContent=row?'编辑预约 '+row.id:'新建预约';$('reminder-id').value=row?.id||'';
  $('reminder-target').value=row?row.scope+':'+row.targetId:'';$('reminder-target').disabled=Boolean(row);
  $('reminder-time-type').value=row?.schedule.timeType||'absolute';$('reminder-when').value=row?.schedule.when||'';$('reminder-repeat').value=row?.schedule.repeat||'once';
  $('reminder-interval').value=row?.schedule.intervalMs?row.schedule.intervalMs/60000+'分钟':'';$('reminder-end').value=row?.schedule.endAt?new Date(row.schedule.endAt+8*3600000).toISOString().slice(0,19).replace('T',' '):'';
  $('reminder-content').value=row?.content||'';reminderTimeFields();placeReminderEditor(row?.id);reminderEditorNode.scrollIntoView({block:'nearest'});
}
$('reminder-new').onclick=guarded(async()=>{await loadReminders();reminderEditor();});$('reminder-editor-close').onclick=closeReminderEditor;
$('reminder-time-type').onchange=reminderTimeFields;$('reminder-repeat').onchange=reminderTimeFields;
$('reminder-form').onsubmit=guarded(async()=>{
  if(reminderBusy)return;reminderBusy=true;$('reminder-save').disabled=true;
  try{
    const target=$('reminder-target').value,index=target.indexOf(':');if(index<0)throw new Error('请先选择发送目标；尚无目标时先在 QQ 中与机器人聊天。');
    const body={scope:target.slice(0,index),targetId:target.slice(index+1),timeType:$('reminder-time-type').value,when:$('reminder-when').value.trim(),repeat:$('reminder-repeat').value,interval:$('reminder-interval').value.trim(),endAt:$('reminder-end').value.trim(),content:$('reminder-content').value.trim(),requestId:reminderRequestId};
    const id=$('reminder-id').value;if(id)body.revision=reminderRevision;
    const row=await api('/api/plugins/reminders/tasks'+(id?'/'+id:''),id?'PATCH':'POST',body);
    closeReminderEditor();reminderSignature='';await loadReminders();notify(`预约 ${row.id} 已保存，下次 ${reminderTime(row.nextAt)}。`);
  }finally{reminderBusy=false;$('reminder-save').disabled=false;}
});
const handleReminderRowAction=guarded(async event=>{
  const button=event.target.closest('[data-reminder-action]');if(!button||reminderBusy)return;
  const row=reminderRows.find(row=>row.id===button.dataset.id);if(!row)return;const action=button.dataset.reminderAction;
  if(action==='edit'){
    if($('reminder-id').value===row.id&&!reminderEditorNode.classList.contains('hidden')){closeReminderEditor();return;}
    reminderBusy=true;try{reminderEditor(await api('/api/plugins/reminders/tasks/'+row.id));}finally{reminderBusy=false;}return;
  }
  if(action==='history'){
    const detail=await api('/api/plugins/reminders/tasks/'+row.id);$('reminder-history-meta').textContent=`${detail.id} · ${reminderTargetLabel(detail)} · ${detail.content}`;
    $('reminder-history-body').innerHTML=detail.deliveries.length?detail.deliveries.map(log=>`<div class="memory-message"><small>预约 ${reminderTime(log.scheduledAt)} · 处理 ${reminderTime(log.startedAt)}</small>${esc({sent:'已送达',active:'跳过旧周期，等待下次',failed:'平台拒绝',uncertain:'结果未知',missed:'已错过',sending:'发送中'}[log.state]||log.state)}${log.error?'<br>'+esc(log.error):''}</div>`).join(''):'<p class="muted">还没有到时发送记录。</p>';$('reminder-history-dialog').showModal();return;
  }
  if(action==='delete'&&!await confirmAction('删除预约',`删除“${row.content}”及其发送记录，停止后续提醒。此操作不能撤销；暂时停用可选择暂停。`,'删除预约'))return;
  if(action==='resume'&&row.state!=='paused'&&!await confirmAction('核对后恢复','上次提醒可能已送达。确认接收方尚未收到后再恢复，单次预约会再次发送，重复预约从下一周期继续。','恢复'))return;
  reminderBusy=true;button.disabled=true;try{
    await api('/api/plugins/reminders/tasks/'+row.id+(action==='delete'?'':'/'+action),action==='delete'?'DELETE':'POST',{revision:row.revision});
    if($('reminder-id').value===row.id)closeReminderEditor();reminderSignature='';await loadReminders();notify(action==='delete'?'预约及发送记录已删除。':'预约状态已更新。');
  }finally{reminderBusy=false;button.disabled=false;}
});
$('reminder-rows').addEventListener('click',event=>{
  // 行内表单也在列表中，只拦截预约操作按钮，让表单正常提交。
  if(event.target.closest('[data-reminder-action]'))handleReminderRowAction(event);
});
$('reminder-state').onchange=guarded(async()=>{reminderPage=1;await loadReminders();});$('reminder-search').oninput=()=>{clearTimeout(reminderSearchTimer);reminderSearchTimer=setTimeout(()=>{reminderPage=1;loadReminders().catch(error=>notify(error.message,true));},250);};
$('reminder-prev').onclick=guarded(async()=>{reminderPage--;await loadReminders();});$('reminder-next').onclick=guarded(async()=>{reminderPage++;await loadReminders();});$('reminder-history-close').onclick=()=>$('reminder-history-dialog').close();
window.QoriPluginUI.register('reminders',{title:'预约提醒',load:loadReminders,poll:loadReminders});
