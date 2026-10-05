export class SessionStore {
  constructor(config, now = Date.now) {
    this.config = config;
    this.now = now;
    this.sessions = new Map();
  }

  prune() {
    const cutoff = this.now() - this.config.sessionTtlMs;
    for (const [key, value] of this.sessions) {
      if (value.updatedAt <= cutoff) this.sessions.delete(key);
    }
  }

  history(key) {
    this.prune();
    const value = this.sessions.get(key);
    return value ? value.messages.map(message => ({ ...message })) : [];
  }

  messages(key, input) {
    const history = this.history(key);
    const size = () => history.reduce((total, message) => total + message.content.length, 0) + input.length;
    while (history.length && size() > this.config.maxContextChars) history.splice(0, 2);
    return [
      { role: 'system', content: this.config.systemPrompt },
      ...history,
      { role: 'user', content: input },
    ];
  }

  commit(key, input, answer) {
    const messages = [...this.history(key), { role: 'user', content: input }, { role: 'assistant', content: answer }];
    while (messages.length > this.config.historyRounds * 2 ||
           (messages.length > 2 && messages.reduce((total, message) => total + message.content.length, 0) > this.config.maxContextChars)) {
      messages.splice(0, 2);
    }
    this.sessions.delete(key);
    this.sessions.set(key, { messages, updatedAt: this.now() });
    while (this.sessions.size > this.config.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
  }

  reset(key) { this.sessions.delete(key); }
}
