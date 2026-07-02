// The page is intentionally self-contained: no external URL (no CDN fonts or
// scripts), so the first slice cannot leak anything off the loopback interface.
export function chatPageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agent-quorum workspace</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        font-family: system-ui, sans-serif;
        max-width: 40rem;
        margin: 2rem auto;
        padding: 0 1rem;
      }
      #transcript {
        list-style: none;
        padding: 0;
        min-height: 8rem;
      }
      #transcript li {
        padding: 0.4rem 0.6rem;
        margin: 0.3rem 0;
        border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        border-radius: 0.4rem;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      form {
        display: flex;
        gap: 0.5rem;
      }
      #message-input {
        flex: 1;
        padding: 0.4rem 0.6rem;
        font: inherit;
      }
      #send {
        padding: 0.4rem 1rem;
        font: inherit;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>agent-quorum workspace</h1>
      <p>Local first slice: messages stay in this process and are discarded on exit.</p>
      <ul id="transcript"></ul>
      <form id="composer">
        <input id="message-input" type="text" autocomplete="off" autofocus />
        <button id="send" type="submit">Send</button>
      </form>
    </main>
    <script>
      const transcript = document.getElementById('transcript');
      const composer = document.getElementById('composer');
      const messageInput = document.getElementById('message-input');

      function renderMessage(message) {
        const item = document.createElement('li');
        item.textContent = message.text;
        transcript.appendChild(item);
      }

      async function loadMessages() {
        const response = await fetch('/api/messages');
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        transcript.replaceChildren();
        for (const message of payload.messages) {
          renderMessage(message);
        }
      }

      composer.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = messageInput.value.trim();
        if (text === '') {
          return;
        }
        const response = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) {
          return;
        }
        messageInput.value = '';
        await loadMessages();
      });

      loadMessages();
    </script>
  </body>
</html>
`;
}
