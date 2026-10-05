export function createLogger(secrets = [], output = console) {
  const values = secrets.filter(Boolean);
  const redact = (value) => {
    let text = String(value);
    for (const secret of values) text = text.split(secret).join('[已隐藏]');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
  };
  const log = (level, message) => {
    const time = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    output[level](`[${time}] ${redact(message)}`);
  };
  return {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
    // SDK 的调试日志包含聊天正文，因此默认关闭。
    debug: () => {},
  };
}
