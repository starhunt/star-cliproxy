// 예제 플러그인: echo 프로바이더
// 입력 메시지를 그대로 반환하는 테스트용 프로바이더

/** @type {import('@star-cliproxy/shared').CliproxyPlugin} */
export default {
  name: 'echo',
  endpointTypes: ['chat'],

  createProvider(_config) {
    return {
      name: 'echo',

      async execute(options) {
        const lastMessage = options.messages[options.messages.length - 1];
        const content = `[echo] ${lastMessage?.content ?? ''}`;
        return {
          content,
          usage: {
            promptTokens: Math.ceil((lastMessage?.content?.length ?? 0) / 4),
            completionTokens: Math.ceil(content.length / 4),
            totalTokens: Math.ceil(content.length / 2),
          },
          finishReason: 'stop',
        };
      },

      async checkHealth() {
        return 'healthy';
      },
    };
  },
};
