'use strict';
let memoryView='profiles',profilePage=1,profileDetailId,profileTimer,profileSignature='';
const scene = kind => kind==='local'?'本机对话':kind==='group'?'群聊':'私聊';
const learningLabels={queued:'等待整理',running:'正在整理',saved:'已保存新资料',no_facts:'没有新的稳定事实',failed:'整理失败，原资料保留',manual:'资料由你手动维护',cancelled:'整理已取消'};
const learningDetail=document.createElement('p');learningDetail.id='profile-learning-detail';learningDetail.className='muted';$('profile-file').before(learningDetail);
const learnButton=document.createElement('button');learnButton.id='learn-profile';learnButton.type='button';learnButton.className='button secondary';learnButton.textContent='整理一次';$('profile-dialog').querySelector('.dialog-actions').prepend(learnButton);
function switchMemoryView(view) {
  memoryView=view;
  $('profile-panel').classList.toggle('hidden',view!=='profiles'); $('session-panel').classList.toggle('hidden',view!=='sessions');
  $('view-profiles').classList.toggle('active',view==='profiles'); $('view-sessions').classList.toggle('active',view==='sessions');
  return view==='profiles'?loadUserProfiles():loadMemory();
}
async function loadUserProfiles() {
  const result=await api(`/api/profiles?page=${profilePage}&q=${encodeURIComponent($('profile-search').value)}`);
  const signature=JSON.stringify([profilePage,$('profile-search').value,result]);
  if(signature===profileSignature) return; profileSignature=signature;
  $('profile-count').textContent=`${result.total} 位用户`; $('profile-page').textContent=`第 ${profilePage} 页`;
  $('profile-prev').disabled=profilePage<=1; $('profile-next').disabled=profilePage*30>=result.total;
  $('profile-rows').innerHTML=result.rows.length?result.rows.map(row=>`<tr><td><strong>${esc(row.alias||(row.kind==='local'?'本机用户':short(row.senderId)))}</strong><small>${row.enabled?'长期资料启用':'长期资料停用'} · ${row.autoLearn?'自动整理':'手动维护'}</small></td><td>${scene(row.kind)}</td><td class="profile-summary">${esc(row.preview||'尚未记录长期资料')}</td><td>${bytes(row.bytes)}</td><td>${date(row.updatedAt)}</td><td><button class="text-button" data-profile="${row.id}">管理 →</button></td></tr>`).join(''):'<tr><td colspan="6" class="empty-table"><strong>还没有长期资料</strong>开始对话后自动建立用户，也可以先编辑“本机用户资料”。</td></tr>';
}
async function openUserProfile(id) {
  const row=await api('/api/profiles/'+id);profileDetailId=id;
  $('profile-meta').textContent=`${scene(row.kind)} · ${row.kind==='local'?'本机用户':row.senderId}`;
  $('profile-alias').value=row.alias; $('profile-notes').value=row.notes; $('profile-notes').maxLength=settings.limits.userMemoryChars;
  $('profile-enabled').checked=Boolean(row.enabled);$('profile-auto').checked=Boolean(row.autoLearn);$('profile-file').textContent=row.path;
  $('profile-learning-detail').textContent=`${learningLabels[row.learnStatus]||'尚未触发整理'} · 累计待整理 ${row.pendingTurns} 条${row.learnedAt?' · 最近整理 '+date(row.learnedAt):''}${row.sources.length?'\n资料来源：'+row.sources.map(s=>`${date(s.at)} · ${s.messageId}`).join('\n'):''}`;
  updateProfileCounter(); if(!$('profile-dialog').open) $('profile-dialog').showModal();
}
function updateProfileCounter(){ $('profile-chars').textContent=`${$('profile-notes').value.length} / ${settings.limits.userMemoryChars} 字符`; }
$('view-profiles').onclick=guarded(()=>switchMemoryView('profiles'));$('view-sessions').onclick=guarded(()=>switchMemoryView('sessions'));
$('open-local-profile').onclick=guarded(async()=>{const row=await api('/api/profiles/local','POST');await openUserProfile(row.id);await loadUserProfiles();});
$('profile-notes').oninput=updateProfileCounter;
$('profile-search').oninput=()=>{clearTimeout(profileTimer);profileTimer=setTimeout(()=>{profilePage=1;loadUserProfiles().catch(error=>notify(error.message,true));},250);};
$('profile-prev').onclick=guarded(async()=>{profilePage--;await loadUserProfiles();});$('profile-next').onclick=guarded(async()=>{profilePage++;await loadUserProfiles();});
$('profile-rows').addEventListener('click',guarded(async event=>{const button=event.target.closest('[data-profile]');if(button) await openUserProfile(button.dataset.profile);}));
$('close-profile').onclick=()=>$('profile-dialog').close();
$('save-profile').onclick=guarded(async()=>{await api('/api/profiles/'+profileDetailId,'PATCH',{alias:$('profile-alias').value.trim(),notes:$('profile-notes').value.trim(),enabled:$('profile-enabled').checked,autoLearn:$('profile-auto').checked});$('profile-dialog').close();await loadUserProfiles();await refreshStatus();notify('长期用户资料已保存。');});
$('export-profile').onclick=guarded(async()=>{const result=await api(`/api/profiles/${profileDetailId}/export`,'POST');notify('已导出：'+result.path);});
$('learn-profile').onclick=guarded(async()=>{await api(`/api/profiles/${profileDetailId}/learn`,'POST');await openUserProfile(profileDetailId);notify('已加入整理队列；整理结果可在用户详情中查看。');});
$('clear-profile').onclick=guarded(async()=>{if(!await confirmAction('清空长期记忆','删除这位用户的长期资料正文，保留用户备注和记忆开关。','清空'))return;await api('/api/profiles/'+profileDetailId,'PATCH',{notes:''});await openUserProfile(profileDetailId);await loadUserProfiles();notify('长期资料已清空。');});
$('delete-profile').onclick=guarded(async()=>{if(!await confirmAction('删除用户资料','删除该用户的长期资料、备注与开关。近期对话保留。后续聊天可重新建立用户资料。','删除'))return;await api('/api/profiles/'+profileDetailId,'DELETE');$('profile-dialog').close();await loadUserProfiles();await refreshStatus();notify('用户资料已删除。');});
