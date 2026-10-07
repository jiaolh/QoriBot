'use strict';
let selectedPrivate = '', privateListSignature = '', privateSearchTimer, privateProfileId = '', privateDetailRequest = 0;

async function loadPrivate(initial = false) {
  if (initial) {
    settings = await api('/api/settings');
    const provider = settings.providers.find(p => p.id === settings.activeProviderId);
    const prompt = settings.prompts.find(p => p.id === settings.activePromptId);
    $('private-defaults').textContent = `${provider.name} · ${provider.model} · ${prompt.name} · 发送间隔 ${settings.limits.cooldownMs / 1000} 秒 · 保存 ${settings.limits.historyRounds} 轮近期对话`;
  }
  const query = $('private-search').value, result = await api('/api/private?q=' + encodeURIComponent(query));
  if (query !== $('private-search').value) return;
  $('private-stats').textContent = `${result.rows.length} 位用户 · 私聊今日 ${result.todayTokens.toLocaleString()} tokens`;
  const signature = JSON.stringify([result.rows, settings.providers, settings.prompts, settings.activeProviderId, settings.activePromptId]);
  if (signature !== privateListSignature) {
    privateListSignature = signature;
    $('private-rows').innerHTML = result.rows.length ? result.rows.map(row => {
      const provider = settings.providers.find(p => p.id === (row.policy.replyProviderId || settings.activeProviderId));
      const prompt = settings.prompts.find(p => p.id === (row.policy.promptId || settings.activePromptId));
      return `<tr><td><strong>${esc(row.policy.alias || short(row.userId))}</strong><small>${row.policy.enabled ? '回复开启' : '回复关闭'} · ${row.lastSeen ? '最近 ' + date(row.lastSeen) : '等待私聊消息'}</small></td><td>${esc(provider?.model || '待配置')}<small>${esc(prompt?.name || '待配置')}</small></td><td>${row.rounds} 轮 · ${bytes(row.bytes)}</td><td>${row.repliesHour}${row.policy.maxRepliesHour ? ' / ' + row.policy.maxRepliesHour : ''}</td><td>${row.todayTokens.toLocaleString()}</td><td><button class="text-button" data-private="${esc(row.userId)}">管理 →</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-table">尚无匹配的私聊用户。机器人收到私聊后会自动发现用户，也可按平台用户标识提前添加。</td></tr>';
  }
  if (selectedPrivate) await refreshPrivateDetail();
}

function privateOptions(id, rows, label) {
  $(id).innerHTML = `<option value="">${label}</option>` + rows.map(row => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');
}

async function openPrivate(id = '') {
  selectedPrivate = id; privateProfileId = '';
  const request = ++privateDetailRequest;
  const row = id ? await api('/api/private/' + encodeURIComponent(id)) : null;
  if (request !== privateDetailRequest) return;
  const policy = row?.policy || { enabled: true, alias: '', promptId: '', replyProviderId: '', cooldownMs: null, maxRepliesHour: 0, dailyTokenLimit: 0, quietStart: '', quietEnd: '' };
  $('private-detail').classList.remove('hidden'); $('private-title').textContent = policy.alias || '私聊设置';
  $('private-id').value = id; $('private-id').readOnly = Boolean(id);
  privateOptions('private-prompt', settings.prompts, '跟随当前提示词'); privateOptions('private-reply-api', settings.providers, '跟随当前 API');
  for (const [field, key] of [['alias', 'alias'], ['enabled', 'enabled'], ['prompt', 'promptId'], ['reply-api', 'replyProviderId'], ['replies', 'maxRepliesHour'], ['budget', 'dailyTokenLimit'], ['quiet-start', 'quietStart'], ['quiet-end', 'quietEnd']]) $('private-' + field).value = String(policy[key]);
  $('private-cooldown').value = policy.cooldownMs === null ? '' : policy.cooldownMs / 1000;
  renderPrivateDetail(row);
  $('private-detail').scrollIntoView({ block: 'start' });
}

function renderPrivateDetail(row) {
  privateProfileId = row?.profileId || '';
  $('private-profile').disabled = !privateProfileId; $('private-clear').disabled = !row;
  $('private-messages').innerHTML = row?.sessions.length ? row.sessions.map(session => {
    const prompt = settings.prompts.find(p => p.id === session.promptId);
    return `<div class="private-session"><h3>${esc(prompt?.name || '已删除的提示词')}${session.enabled ? '' : ' · 近期记忆停用'}</h3>${session.messages.map(message => `<div class="memory-message ${message.role === 'assistant' ? 'assistant' : ''}"><small>${message.role === 'user' ? '用户' : '机器人'}</small>${esc(message.content)}</div>`).join('') || '<div class="empty-inline">此提示词下暂无保留的对话正文。</div>'}</div>`;
  }).join('') : '<div class="empty-inline">暂无近期私聊对话。长期资料可在“用户记忆”中管理。</div>';
}

async function refreshPrivateDetail() {
  if (!selectedPrivate) return;
  const id = selectedPrivate, request = ++privateDetailRequest;
  const row = await api('/api/private/' + encodeURIComponent(id));
  if (id === selectedPrivate && request === privateDetailRequest) renderPrivateDetail(row);
}

$('refresh-private').onclick = guarded(() => loadPrivate(true));
$('private-search').oninput = () => { clearTimeout(privateSearchTimer); privateSearchTimer = setTimeout(() => loadPrivate().catch(error => notify(error.message, true)), 250); };
$('private-rows').addEventListener('click', guarded(async event => { const button = event.target.closest('[data-private]'); if (button) await openPrivate(button.dataset.private); }));
$('add-private').onclick = guarded(() => openPrivate());
$('close-private').onclick = () => { selectedPrivate = ''; privateDetailRequest++; $('private-detail').classList.add('hidden'); };
$('private-policy-form').onsubmit = guarded(async () => {
  const id = $('private-id').value.trim();
  if (!id) throw new Error('请填写私聊用户标识。');
  const policy = { enabled: $('private-enabled').value === 'true', alias: $('private-alias').value.trim(), promptId: $('private-prompt').value, replyProviderId: $('private-reply-api').value,
    cooldownMs: $('private-cooldown').value === '' ? null : Math.round(Number($('private-cooldown').value) * 1000), maxRepliesHour: Number($('private-replies').value), dailyTokenLimit: Number($('private-budget').value), quietStart: $('private-quiet-start').value, quietEnd: $('private-quiet-end').value };
  await saveSettings({ privateChat: { users: { ...settings.privateChat.users, [id]: policy } } });
  await openPrivate(id); await loadPrivate(true); await refreshStatus(); notify('私聊设置已保存，新消息立即生效。');
});
$('private-profile').onclick = guarded(async () => { if (privateProfileId) await openUserProfile(privateProfileId); });
$('private-clear').onclick = guarded(async () => {
  if (!selectedPrivate) throw new Error('请先保存私聊设置。');
  if (!await confirmAction('清空这位用户的近期私聊', '清空该私聊所有提示词下的近期对话正文，保留长期资料、记忆开关、群聊记忆和已使用的预算。', '清空正文')) return;
  await api('/api/private/' + encodeURIComponent(selectedPrivate) + '/clear', 'POST'); await loadPrivate(); await refreshStatus(); notify('近期私聊对话已清空。');
});
