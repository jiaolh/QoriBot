'use strict';
let selectedGroup = '', groupListSignature = '', groupJoinPending = false;
const groupModes = { light:'轻量', observe:'观察', active:'全能' };
const groupActions = { reply:'决定接话', wait:'等待后续', skip:'保持安静', would_reply:'观察：准备接话', sent:'已发送', stale:'取消过时回复', error:'处理失败', summary_error:'摘要未完成', manual_requested:'手动加入：生成中', manual_sent:'已手动加入话题', manual_error:'手动加入未完成' };
const groupDefaults = {mode:'light',alias:'',promptId:'',replyProviderId:'',judgeProviderId:'',cooldownMs:30000,minJudgeIntervalMs:15000,maxRepliesHour:24,maxJudgesHour:120,dailyTokenLimit:0,quietStart:'',quietEnd:'',ignoreSenderIds:[]};
async function loadGroups(initial = false) {
  const result = await api('/api/groups');
  $('group-stats').textContent = `${result.stats.messages} 条 · ${bytes(result.stats.bytes)} · 今日 ${result.stats.todayTokens.toLocaleString()} tokens`;
  $('group-retention-description').textContent=`逐群选择轻量、观察或全能模式。普通消息原文与群话题摘要保留 ${result.stats.retentionHours} 小时。`;
  if (initial) { $('group-retention-hours').value=settings.groupChat.messageTtlMs/3600000; $('group-max-bytes').value = settings.groupChat.maxBytes / 1048576; $('group-daily-budget').value = settings.groupChat.dailyTokenLimit; }
  const signature = JSON.stringify(result.rows);
  if(signature !== groupListSignature){ groupListSignature=signature;
    $('group-rows').innerHTML = result.rows.length ? result.rows.map(row=>`<tr><td><strong>${esc(row.policy.alias||short(row.groupId))}</strong><small>${groupModes[row.policy.mode]}</small></td><td>${row.lastFullAt?'已检测到全量消息':'尚未检测到普通消息'}<small>${row.lastSeen?'最近 '+date(row.lastSeen):'等待群消息'}</small></td><td>${row.messages}</td><td>${row.repliesHour} / ${row.judgesHour}</td><td>${row.todayTokens.toLocaleString()}</td><td><button class="text-button" data-group="${esc(row.groupId)}">管理 →</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty-table">机器人收到群消息后，这里会出现对应的群。也可按群标识提前添加。</td></tr>';
  }
  if(selectedGroup) await refreshGroupDetail();
}
function groupOptions(id, rows, label) { $(id).innerHTML = `<option value="">${label}</option>`+rows.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join(''); }
async function openGroup(id, fresh = false) {
  selectedGroup = id; const policy = {...groupDefaults,...settings.groupChat.groups[id]};
  $('group-detail').classList.remove('hidden'); $('group-title').textContent=policy.alias||'群设置'; $('group-id').value=id; $('group-id').readOnly=!fresh;
  groupOptions('group-prompt',settings.prompts,'跟随当前提示词');groupOptions('group-judge-api',settings.providers,'跟随当前 API');groupOptions('group-reply-api',settings.providers,'跟随当前 API');
  for(const [field,key] of [['alias','alias'],['mode','mode'],['prompt','promptId'],['judge-api','judgeProviderId'],['reply-api','replyProviderId'],['replies','maxRepliesHour'],['judges','maxJudgesHour'],['budget','dailyTokenLimit'],['quiet-start','quietStart'],['quiet-end','quietEnd']]) $('group-'+field).value=policy[key];
  $('group-cooldown').value=policy.cooldownMs/1000;$('group-judge-interval').value=policy.minJudgeIntervalMs/1000;$('group-ignore').value=policy.ignoreSenderIds.join('\n');
  if(id) await refreshGroupDetail(); else { $('group-summary').textContent='暂无摘要';$('group-decisions').textContent='暂无记录';$('group-messages').textContent='暂无消息';$('group-join').disabled=true;$('group-join-status').textContent='先保存群设置，并接收近期群消息'; }
  $('group-detail').scrollIntoView({block:'start'});
}
async function refreshGroupDetail() {
  if(!selectedGroup)return; const id=selectedGroup,row=await api('/api/groups/'+encodeURIComponent(id));if(id!==selectedGroup)return;
  $('group-summary').textContent=row.summary||'暂无摘要；可以等待自动整理，或点击“整理一次”。';
  $('group-join').disabled=groupJoinPending||!row.participation.available;
  $('group-join').textContent=groupJoinPending?'正在加入…':'加入当前话题';
  $('group-join-status').textContent=groupJoinPending?'正在生成并发送一条群消息…':row.participation.reason||(row.participation.proactive?'最近群消息较早，本次发送需要 QQ 官方主动消息权限与额度。':'点击后直接参与一次，跳过自动接话判断；观察或轻量模式也可以手动发送。');
  $('group-decisions').innerHTML=row.decisions.map(item=>`<div class="memory-message"><small>${date(item.at)} · ${esc(groupActions[item.action]||item.action)}</small>${esc(item.reason)}</div>`).join('')||'<div class="empty-inline">暂无接话记录</div>';
  $('group-messages').innerHTML=[...row.messages].reverse().map(item=>`<div class="memory-message ${item.direction==='out'?'assistant':''}"><small>${date(item.at)} · ${esc(item.direction==='out'?'机器人':item.senderName||short(item.senderId))}${item.mentioned?' · @机器人':''}</small>${esc(item.content)}</div>`).join('')||'<div class="empty-inline">尚无保留的群消息</div>';
}
$('refresh-groups').onclick=guarded(()=>loadGroups(true));
$('group-rows').addEventListener('click',guarded(async event=>{const button=event.target.closest('[data-group]');if(button)await openGroup(button.dataset.group);}));
$('add-group').onclick=guarded(()=>openGroup('',true));$('close-group').onclick=()=>{selectedGroup='';$('group-detail').classList.add('hidden');};
$('group-global-form').onsubmit=guarded(async()=>{await saveSettings({groupChat:{messageTtlMs:Number($('group-retention-hours').value)*3600000,maxBytes:Number($('group-max-bytes').value)*1048576,dailyTokenLimit:Number($('group-daily-budget').value)}});await loadGroups();notify('群聊资源限制已保存。');});
$('group-policy-form').onsubmit=guarded(async()=>{
  const id=$('group-id').value.trim(); if(!id)throw new Error('请填写群标识');
  const policy={mode:$('group-mode').value,alias:$('group-alias').value.trim(),promptId:$('group-prompt').value,replyProviderId:$('group-reply-api').value,judgeProviderId:$('group-judge-api').value,
    cooldownMs:Number($('group-cooldown').value)*1000,minJudgeIntervalMs:Number($('group-judge-interval').value)*1000,maxRepliesHour:Number($('group-replies').value),maxJudgesHour:Number($('group-judges').value),dailyTokenLimit:Number($('group-budget').value),quietStart:$('group-quiet-start').value,quietEnd:$('group-quiet-end').value,ignoreSenderIds:$('group-ignore').value.split('\n').map(x=>x.trim()).filter(Boolean)};
  await saveSettings({groupChat:{groups:{...settings.groupChat.groups,[id]:policy}}}); selectedGroup=id;await openGroup(id);await loadGroups();await refreshStatus();notify('群设置已保存，新消息立即生效。');
});
$('group-summary-now').onclick=guarded(async()=>{if(!selectedGroup)throw new Error('请先保存群设置');$('group-summary-now').disabled=true;try{await api('/api/groups/'+encodeURIComponent(selectedGroup)+'/summary','POST');await refreshGroupDetail();notify('群摘要已整理。');}finally{$('group-summary-now').disabled=false;}});
$('group-join').onclick=guarded(async()=>{
  if(groupJoinPending)return;if(!selectedGroup)throw new Error('请先选择并保存群设置');
  const id=selectedGroup;groupJoinPending=true;$('group-join').disabled=true;$('group-join').textContent='正在加入…';$('group-join-status').textContent='正在生成并发送一条群消息…';
  try{const result=await api('/api/groups/'+encodeURIComponent(id)+'/join','POST');if(result.sent)notify('Bot 已加入当前话题，消息已发送。');}
  finally{groupJoinPending=false;await loadGroups();await refreshStatus();}
});
$('group-clear').onclick=guarded(async()=>{if(!selectedGroup)throw new Error('请先保存群设置');if(!await confirmAction('清空群上下文','清空这个群的消息原文、接话记录和话题摘要，并取消待发回复。长期个人资料与已使用的预算保留。','清空'))return;await api('/api/groups/'+encodeURIComponent(selectedGroup)+'/clear','POST');await loadGroups();notify('群上下文已清空。');});
