'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="local-token"]').content;
let settings, status, promptId, providerId, detailId, currentPage = 'overview', memoryPage = 1, memoryTotal = 0;
let toastTimer, searchTimer, pollTimer, disconnected = false, polling = false;
let botActionPending=false,statusPending=null,renderedLogs='',renderedStorageAt=0,sessionSignature='';
let toolCheckPending = false;
const names = { overview: '运行概览', prompts: '提示词工作室', memory: '用户记忆', groups: '群聊模式', plugins: '插件管理', settings: 'API 与机器人', storage: '存储与环境' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : value < 1073741824 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1073741824).toFixed(2)} GB`;
const short = value => value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function notify(message, error = false) {
  $('toast').textContent = message; $('toast').classList.remove('hidden'); $('toast').classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7000 : 4000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
function guarded(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (error) { notify(error.message, true); } }; }
function confirmAction(title, description, label = '确认') {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-ok').textContent = label;
  const dialog = $('confirm-dialog'); dialog.showModal();
  return new Promise(resolve => {
    const done = value => { dialog.close(); $('confirm-ok').onclick = null; $('confirm-cancel').onclick = null; dialog.oncancel = null; resolve(value); };
    $('confirm-ok').onclick = () => done(true); $('confirm-cancel').onclick = () => done(false);
    dialog.oncancel = event => { event.preventDefault(); done(false); };
  });
}

function navigate(page) {
  if (!names[page] && !window.QoriPluginUI?.pages.has(page)) return;
  const pluginPage=window.QoriPluginUI?.pages.get(page);
  currentPage = page; $('page-name').textContent = names[page]||`${names.plugins} / ${pluginPage.title}`;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === (pluginPage?'plugins':page)));
  if (page === 'memory') switchMemoryView(memoryView).catch(error => notify(error.message, true));
  if (page === 'groups') loadGroups(true).catch(error => notify(error.message, true));
  if(page==='plugins')loadPlugins().catch(error=>notify(error.message,true));
  window.QoriPluginUI?.pages.get(page)?.load().catch(error=>notify(error.message,true));
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', event => {
  const navigation = event.target.closest('[data-page]'); if (navigation) navigate(navigation.dataset.page);
});

function renderSummary() {
  const provider = settings.providers.find(item => item.id === settings.activeProviderId);
  const prompt = settings.prompts.find(item => item.id === settings.activePromptId);
  $('current-api').textContent = provider.name; $('current-model').textContent = provider.model;
  $('current-search').textContent = provider.webSearch ? '官方搜索 · 按需调用' : '普通对话';
  $('current-search').classList.toggle('green', provider.webSearch);
  $('current-prompt').textContent = prompt.name; $('current-prompt-text').textContent = prompt.content;
}
function renderPrompts() {
  $('prompt-list').innerHTML = settings.prompts.map(prompt => `<button class="profile-card ${prompt.id === promptId ? 'selected' : ''}" data-prompt="${esc(prompt.id)}"><div class="profile-top"><strong>${esc(prompt.name)}</strong>${prompt.id === settings.activePromptId ? '<span class="tag green">使用中</span>' : '<span class="tag soft">提示词</span>'}</div><p>${esc(prompt.content)}</p></button>`).join('');
}
function promptEditor(id) {
  promptId = id; const prompt = settings.prompts.find(item => item.id === id);
  $('prompt-name').value = prompt?.name || ''; $('prompt-content').value = prompt?.content || '';
  $('prompt-editor-title').textContent = prompt ? '编辑提示词' : '新建提示词';
  $('prompt-active-tag').textContent = id === settings.activePromptId ? '使用中' : '未启用';
  $('activate-prompt').disabled = !prompt || id === settings.activePromptId;
  $('delete-prompt').disabled = !prompt || settings.prompts.length === 1;
  $('prompt-count').textContent = `${$('prompt-content').value.length} / 20000 字符`; renderPrompts();
}
async function saveSettings(patch) {
  settings = await api('/api/settings', 'PUT', patch); renderSummary(); renderPrompts(); renderProviderTabs();
  return settings;
}
$('prompt-list').addEventListener('click', event => { const button = event.target.closest('[data-prompt]'); if (button) promptEditor(button.dataset.prompt); });
$('new-prompt').onclick = () => { promptEditor(crypto.randomUUID()); $('prompt-name').focus(); };
$('prompt-content').oninput = () => { $('prompt-count').textContent = `${$('prompt-content').value.length} / 20000 字符`; };
$('prompt-form').onsubmit = guarded(async () => {
  const prompt = { id: promptId, name: $('prompt-name').value.trim(), content: $('prompt-content').value.trim() };
  const prompts = settings.prompts.filter(item => item.id !== promptId); prompts.push(prompt);
  await saveSettings({ prompts }); promptEditor(promptId); notify('提示词已保存。');
});
$('activate-prompt').onclick = guarded(async () => { await saveSettings({ activePromptId: promptId }); promptEditor(promptId); notify('提示词已切换，新的问题立即生效。'); });
$('delete-prompt').onclick = guarded(async () => {
  const prompt = settings.prompts.find(item => item.id === promptId);
  if (!await confirmAction('删除提示词', `删除“${prompt.name}”。它已有的用户记忆会保留，可在记忆页面清理。`, '删除')) return;
  const prompts = settings.prompts.filter(item => item.id !== promptId);
  await saveSettings({ prompts, activePromptId: settings.activePromptId === promptId ? prompts[0].id : settings.activePromptId }); promptEditor(settings.activePromptId);
});

function renderProviderTabs() {
  $('provider-tabs').innerHTML = settings.providers.map(provider => `<button class="provider-tab ${provider.id === providerId ? 'active' : ''}" data-provider="${esc(provider.id)}">${esc(provider.name)}${provider.id === settings.activeProviderId ? ' · 使用中' : ''}</button>`).join('');
}
function searchCapability() {
  let supported = false;
  try { const url = new URL($('api-url').value); supported = $('api-protocol').value === 'anthropic' && url.origin === 'https://api.deepseek.com' && url.pathname.replace(/\/$/, '') === '/anthropic'; } catch {}
  $('api-search').disabled = !supported;
  if (!supported) $('api-search').checked = false;
  $('search-support').textContent = supported ? '使用 DeepSeek 官方服务端搜索工具' : '当前接口尚无已确认的官方搜索支持';
  $('search-note').innerHTML = supported
    ? '模型按问题需要调用搜索，搜索由官方 API 执行，可能产生额外模型用量。<a href="https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/#using-web-search-in-claude-code" target="_blank" rel="noreferrer">查看官方说明 ↗</a>'
    : '普通兼容接口仅用于模型对话。需要联网搜索时，可选择 DeepSeek 官方搜索配置并填写对应平台的 Key。';
}
function providerEditor(id) {
  providerId = id; const provider = settings.providers.find(item => item.id === id);
  $('api-name').value = provider?.name || '自定义 API'; $('api-model').value = provider?.model || 'deepseek-flash';
  $('api-protocol').value = provider?.protocol || 'openai'; $('api-url').value = provider?.baseUrl || 'https://api.deepseek.com';
  $('api-key').value = ''; $('api-key-status').textContent = provider?.apiKeySet ? '已保存 · 留空保留' : '尚未填写';
  $('api-search').checked = provider?.webSearch || false;
  $('activate-provider').disabled = !provider || id === settings.activeProviderId; $('delete-provider').disabled = !provider || settings.providers.length === 1;
  $('models-result').classList.add('hidden'); searchCapability(); renderProviderTabs();
  $('check-tools').disabled = toolCheckPending || !provider?.apiKeySet;
  $('tools-result').textContent = '';
}
$('provider-tabs').addEventListener('click', event => { const button = event.target.closest('[data-provider]'); if (button) providerEditor(button.dataset.provider); });
$('new-provider').onclick = () => { providerEditor(crypto.randomUUID()); $('api-name').focus(); };
$('api-url').oninput = searchCapability; $('api-protocol').onchange = searchCapability;
$('provider-form').onsubmit = guarded(async () => {
  const provider = { id: providerId, name: $('api-name').value.trim(), protocol: $('api-protocol').value, baseUrl: $('api-url').value.trim(), model: $('api-model').value.trim(), apiKey: $('api-key').value.trim(), webSearch: $('api-search').checked };
  const providers = settings.providers.filter(item => item.id !== providerId); providers.push(provider);
  await saveSettings({ providers }); providerEditor(providerId); notify('API 配置已保存。');
});
$('activate-provider').onclick = guarded(async () => { await saveSettings({ activeProviderId: providerId }); providerEditor(providerId); notify('已切换 API，新的请求使用此配置。'); });
$('delete-provider').onclick = guarded(async () => {
  const provider = settings.providers.find(item => item.id === providerId);
  if (!await confirmAction('删除 API 配置', `删除“${provider.name}”及其保存在该配置中的 Key。`, '删除')) return;
  const providers = settings.providers.filter(item => item.id !== providerId);
  await saveSettings({ providers, activeProviderId: settings.activeProviderId === providerId ? providers[0].id : settings.activeProviderId }); providerEditor(settings.activeProviderId);
});
$('query-models').onclick = guarded(async () => {
  const button = $('query-models'); button.disabled = true; button.textContent = '正在查询…';
  try {
    const result = await api('/api/models', 'POST', { providerId });
    $('models-result').innerHTML = result.models.length ? result.models.map(model => `<button class="model-choice" data-model="${esc(model)}">${esc(model)}</button>`).join('') : '<span class="muted">当前 Key 未返回可用模型。</span>';
    $('models-result').classList.remove('hidden');
  } finally { button.disabled = false; button.textContent = '查询模型列表'; }
});
$('models-result').addEventListener('click', event => { const model = event.target.closest('[data-model]'); if (model) { $('api-model').value = model.dataset.model; notify('模型已填入，请保存 API 配置。'); } });
$('check-tools').onclick = guarded(async () => {
  if (toolCheckPending) return;
  toolCheckPending = true;
  const button = $('check-tools'), selected = providerId;
  button.disabled = true; button.textContent = '正在测试…';
  $('tools-result').textContent = '正在测试已保存的配置…';
  try {
    const result = await api('/api/tool-check', 'POST', { providerId: selected });
    if (providerId === selected) $('tools-result').textContent = result.message;
  } catch (error) {
    if (providerId === selected) $('tools-result').textContent = error.message;
  } finally {
    toolCheckPending = false;
    button.textContent = '测试插件调用';
    button.disabled = !settings.providers.find(item => item.id === providerId)?.apiKeySet;
  }
});
function renderQQ() {
  const qq = settings.qq; $('qq-id').value = qq.appId; $('qq-secret').value = '';
  $('qq-secret-status').textContent = qq.appSecretSet ? '已保存 · 留空保留' : '尚未填写';
  $('qq-transport').value = qq.transport; $('qq-url').value = qq.baseUrl; $('qq-port').value = qq.webhook.port; $('qq-path').value = qq.webhook.path;
  $('webhook-fields').classList.toggle('hidden', qq.transport !== 'webhook');
}
$('qq-transport').onchange = () => { $('webhook-fields').classList.toggle('hidden', $('qq-transport').value !== 'webhook'); };
$('qq-form').onsubmit = guarded(async () => {
  await saveSettings({ qq: { appId: $('qq-id').value.trim(), appSecret: $('qq-secret').value.trim(), transport: $('qq-transport').value, baseUrl: $('qq-url').value.trim(), webhook: { port: Number($('qq-port').value), path: $('qq-path').value.trim() } } }); renderQQ(); notify('QQ 配置已保存。');
});
function renderLimits() {
  const values = settings.limits;
  $('limit-auto-memory').checked=values.autoMemory; $('limit-profile-chars').value=values.userMemoryChars; $('limit-profile-memory').value=values.maxProfileBytes/1048576;
  for (const [id, key, unit] of [['rounds','historyRounds',1],['ttl','sessionTtlMs',60000],['sessions','maxSessions',1],['memory','maxMemoryBytes',1048576],['concurrent','maxConcurrent',1],['input','maxInputChars',1],['context','maxContextChars',1],['reply','maxReplyBytes',1],['tokens','maxTokens',1],['timeout','timeoutMs',1000],['cooldown','cooldownMs',1000]]) $('limit-' + id).value = values[key] / unit;
  $('limit-temperature').value = values.temperature ?? '';
}
$('limits-form').onsubmit = guarded(async () => {
  const limits = {};
  limits.autoMemory=$('limit-auto-memory').checked;limits.userMemoryChars=Number($('limit-profile-chars').value);limits.maxProfileBytes=Number($('limit-profile-memory').value)*1048576;
  for (const [id, key, unit] of [['rounds','historyRounds',1],['ttl','sessionTtlMs',60000],['sessions','maxSessions',1],['memory','maxMemoryBytes',1048576],['concurrent','maxConcurrent',1],['input','maxInputChars',1],['context','maxContextChars',1],['reply','maxReplyBytes',1],['tokens','maxTokens',1],['timeout','timeoutMs',1000],['cooldown','cooldownMs',1000]]) limits[key] = Number($('limit-' + id).value) * unit;
  limits.temperature = $('limit-temperature').value === '' ? null : Number($('limit-temperature').value);
  if (!await confirmAction('保存性能与记忆限制', '新限制会应用到保存的记忆，超过轮数和容量的较早内容可能被移除。', '保存限制')) return;
  await saveSettings({ limits }); renderLimits(); await refreshStatus(); notify('限制已更新。');
});

async function loadMemory() {
  const result = await api(`/api/memory?page=${memoryPage}&q=${encodeURIComponent($('memory-search').value)}`);
  const signature=JSON.stringify([memoryPage,$('memory-search').value,result]);if(signature===sessionSignature)return;sessionSignature=signature;
  memoryTotal = result.total; $('memory-count').textContent = `${memoryTotal} 条会话`; $('memory-page').textContent = `第 ${memoryPage} 页`;
  $('memory-prev').disabled = memoryPage <= 1; $('memory-next').disabled = memoryPage * 30 >= memoryTotal;
  $('memory-rows').innerHTML = result.rows.length ? result.rows.map(row => {
    const prompt = settings.prompts.find(item => item.id === row.promptId);
    return `<tr><td><strong>${esc(row.alias || (row.kind==='local'?'本机用户':short(row.senderId || '未知用户')))}${row.enabled ? '' : ' <span class="tag soft">记忆停用</span>'}</strong><small>${esc(short(row.senderId))}</small></td><td>${row.kind==='local'?'本机对话':row.kind === 'group' ? '群聊' : '私聊'} <span class="tag">${esc(prompt?.name || '已删除的提示词')}</span></td><td>${row.rounds} 轮</td><td>${bytes(row.bytes)}</td><td>${date(row.updatedAt)}</td><td><button class="text-button" data-memory="${row.id}">管理 →</button></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-table"><strong>还没有保存的记忆</strong>机器人开始对话后，用户记忆会出现在这里。</td></tr>';
}
$('memory-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { memoryPage = 1; loadMemory().catch(error => notify(error.message, true)); }, 250); };
$('memory-prev').onclick = guarded(async () => { memoryPage--; await loadMemory(); });
$('memory-next').onclick = guarded(async () => { memoryPage++; await loadMemory(); });
$('memory-rows').addEventListener('click', guarded(async event => {
  const button = event.target.closest('[data-memory]'); if (!button) return;
  detailId = button.dataset.memory; await openMemory(detailId);
}));
async function openMemory(id) {
  const row = await api('/api/memory/' + id);
  $('memory-detail-meta').textContent = `${row.kind==='local'?'本机对话':row.kind === 'group' ? '群聊' : '私聊'} · 用户标识 ${row.senderId} · ${bytes(row.bytes)}`;
  $('memory-alias').value = row.alias; $('memory-enabled').checked = Boolean(row.enabled);
  $('memory-messages').innerHTML = row.messages.length ? row.messages.map(message => `<div class="memory-message ${message.role}"><small>${message.role === 'user' ? '用户' : '机器人'}</small>${esc(message.content)}</div>`).join('') : '<div class="empty-inline">当前会话没有保存的正文。</div>';
  if (!$('memory-dialog').open) $('memory-dialog').showModal();
}
$('close-memory').onclick = () => $('memory-dialog').close();
$('export-memory').onclick = guarded(async () => { const result = await api(`/api/memory/${detailId}/export`, 'POST'); notify(`记忆已保存到项目：${result.path}`); });
$('save-memory').onclick = guarded(async () => { await api('/api/memory/' + detailId, 'PATCH', { alias: $('memory-alias').value.trim(), enabled: $('memory-enabled').checked }); $('memory-dialog').close(); await loadMemory(); notify('记忆设置已保存。'); });
$('clear-one-memory').onclick = guarded(async () => {
  if (!await confirmAction('清空当前会话', '删除该会话保存的对话正文，保留备注和记忆开关。', '清空正文')) return;
  await api('/api/memory/' + detailId, 'PATCH', { clear: true }); await openMemory(detailId); await loadMemory(); notify('会话正文已清空。');
});
$('delete-memory').onclick = guarded(async () => {
  if (!await confirmAction('删除当前会话', '同时删除对话、备注和记忆开关。该用户后续聊天时可重新建立会话。', '删除会话')) return;
  await api('/api/memory/' + detailId, 'DELETE'); $('memory-dialog').close(); await loadMemory(); notify('会话已删除。');
});
$('clear-memory').onclick = guarded(async () => {
  if (!await confirmAction('清空所有记忆正文', '清空所有用户的对话历史。备注和停用设置保留，此操作不能撤销；建议先备份。', '清空所有正文')) return;
  await api('/api/memory/clear', 'POST'); await loadMemory(); await refreshStatus(); notify('所有记忆正文已清空。');
});

function renderStatus() {
  const labels = { stopped: '未启动', starting: '连接中', running: '运行中', stopping: '停止中', error: '连接失败' };
  $('bot-status').textContent = labels[status.bot.state] || '未启动'; $('bot-status').className = `status-pill ${status.bot.state}`;
  const running = ['starting', 'running'].includes(status.bot.state);
  const retrying=status.bot.retryAfterMs>0;
  $('bot-toggle').textContent = running ? '停止机器人 ■' : retrying?`${Math.ceil(status.bot.retryAfterMs/1000)} 秒后重试`:'启动机器人 ▶'; $('bot-toggle').disabled = botActionPending || status.bot.state === 'stopping' || retrying;
  $('connection-error').textContent=status.bot.error||'';$('connection-error').classList.toggle('hidden',!status.bot.error);
  $('stat-rss').textContent = bytes(status.process.rss); $('stat-cpu').textContent = `${status.process.cpu}%`;
  $('stat-heap').textContent=`堆内存 ${bytes(status.process.heap)} · 不含浏览器`;
  $('stat-sessions').textContent = `${status.profiles.users} / ${status.memory.sessions}`; $('stat-memory').textContent = `长期 ${bytes(status.profiles.bytes)} · 近期 ${bytes(status.memory.logicalBytes)}`;
  $('learning-status').textContent=status.memoryLearning.active?'正在整理长期记忆…':status.memoryLearning.queued?`${status.memoryLearning.queued} 项记忆待整理`:settings.limits.autoMemory?'自动整理已开启':'自动整理已关闭';
  $('stat-active').textContent = status.bot.activeRequests; $('stat-requests').textContent = `本次启动：请求 ${status.usage.requests} · 整理调用 ${status.usage.memoryRequests}`;
  $('stat-requests').title = '服务重启后计数归零；整理调用次数不代表已保存的长期资料条数。';
  const modes = Object.values(settings.groupChat.groups);
  $('mode-badge').textContent = modes.some(g=>g.mode==='active')?'全能模式已开启':modes.some(g=>g.mode==='observe')?'群聊观察中':'轻量模式';
  const minutes = Math.floor(status.process.uptimeMs / 60000); $('uptime').textContent = minutes ? `服务运行 ${minutes} 分钟` : '服务刚刚启动';
  const logs=JSON.stringify(status.logs.slice(-12));
  if(logs!==renderedLogs){renderedLogs=logs;$('logs').innerHTML = status.logs.slice(-12).reverse().map(log => `<div class="log-line ${log.level}"><time>${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>${esc(log.message.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, ''))}</span></div>`).join('');}
  $('storage-total').textContent = bytes(status.storage.totalBytes); $('env-node').textContent = `Node.js ${status.process.node} · Windows x64`;
  if(renderedStorageAt===status.storage.measuredAt)return;renderedStorageAt=status.storage.measuredAt;
  const max = Math.max(1, ...status.storage.groups.map(group => group.bytes));
  $('storage-bars').innerHTML = status.storage.groups.filter(group => group.bytes || ['data','.cache','backups'].includes(group.path)).map(group => `<div class="storage-row"><div class="bar-label"><span>${group.name}<code>${group.path}/</code></span><span>${bytes(group.bytes)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, group.bytes / max * 100)}%"></div></div></div>`).join('');
}
function refreshStatus() { if(statusPending)return statusPending;statusPending=api('/api/status').then(value=>{status=value;renderStatus();}).finally(()=>{statusPending=null;});return statusPending; }
$('bot-toggle').onclick = guarded(async () => {if(botActionPending)return;const running = ['starting','running'].includes(status?.bot.state);botActionPending=true;$('bot-toggle').disabled=true;try { await api(running ? '/api/bot/stop' : '/api/bot/start', 'POST'); await refreshStatus(); } finally {botActionPending=false;if(status)renderStatus();} });
$('test-form').onsubmit = guarded(async () => {
  $('test-send').disabled = true; $('test-send').textContent = '生成中…'; $('test-output').classList.remove('hidden'); $('test-output').textContent = '正在等待模型回答…';
  try { const result = await api('/api/test-chat', 'POST', { input: $('test-input').value.trim() }); $('test-output').textContent = result.text; }
  catch (error) { $('test-output').textContent = error.message; throw error; }
  finally { $('test-send').disabled = false; $('test-send').textContent = '发送 ↗'; await refreshStatus(); }
});
$('backup-data').onclick = guarded(async () => { const result = await api('/api/backup', 'POST'); await refreshStatus(); notify(`备份已创建：${result.path}（包含密钥，请自行保管）`); });
$('compact-memory').onclick = guarded(async () => { await api('/api/memory/compact', 'POST'); await refreshStatus(); notify('数据库已压缩。'); });
for (const [id, scope, title, description] of [
  ['clean-cache', '.cache', '清理安装缓存', '删除安装下载缓存。已安装的依赖、运行环境、配置和记忆保留。'],
  ['clean-backups', 'backups', '删除全部历史备份', '删除 backups 下的全部备份。当前配置和记忆保留，但这些备份无法再用于恢复。'],
]) $(id).onclick = guarded(async () => { if (!await confirmAction(title, description, '确认清理')) return; await api('/api/storage/cleanup', 'POST', { scope }); await refreshStatus(); notify('清理完成。'); });
$('refresh-storage').onclick = guarded(async () => { await api('/api/storage/refresh', 'POST'); await refreshStatus(); notify('目录大小已刷新。'); });
$('quit-app').onclick = guarded(async () => {
  if (!await confirmAction('退出 QoriBot', '停止机器人并关闭本地服务。下次可双击启动入口重新打开。', '退出程序')) return;
  await api('/api/shutdown', 'POST'); disconnected = true; clearTimeout(pollTimer); $('bot-status').textContent = '服务已退出'; $('bot-toggle').disabled = true; notify('程序已退出，可以关闭这个页面。');
});
async function poll() {
  if (disconnected) return;
  if (!document.hidden && !polling) {
    polling = true;
    try { await refreshStatus(); if (currentPage === 'memory' && !$('memory-dialog').open && !$('profile-dialog').open) await switchMemoryView(memoryView); if(currentPage==='groups') await loadGroups(); if(currentPage==='plugins')await loadPlugins(); await window.QoriPluginUI?.pages.get(currentPage)?.poll?.(); }
    catch { $('bot-status').textContent = '服务未连接'; }
    finally { polling = false; }
  }
  pollTimer = setTimeout(poll, 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !disconnected) refreshStatus().catch(() => {}); });
async function init() {
  try {
    settings = await api('/api/settings'); promptEditor(settings.activePromptId); providerEditor(settings.activeProviderId); renderQQ(); renderLimits(); renderSummary();
    await refreshStatus(); pollTimer = setTimeout(poll, 5000);
  } catch (error) { notify('无法加载控制台：' + error.message, true); }
}
init();
