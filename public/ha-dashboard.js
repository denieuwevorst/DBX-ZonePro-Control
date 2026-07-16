(() => {
  const editor = document.getElementById('editor');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusMsg = document.getElementById('statusMsg');

  function setStatus(text, kind) {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg ${kind || ''}`.trim();
  }

  async function load() {
    setStatus('Genereren\u2026', '');
    try {
      const res = await fetch('/api/ha-dashboard');
      const text = await res.text();
      if (!res.ok) {
        setStatus(text, 'err');
        return;
      }
      editor.value = text;
      setStatus('', '');
    } catch (err) {
      setStatus(`Kon dashboard niet genereren: ${err.message}`, 'err');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(editor.value);
      setStatus('Gekopieerd naar klembord.', 'ok');
    } catch (err) {
      editor.select();
      document.execCommand('copy');
      setStatus('Gekopieerd naar klembord.', 'ok');
    }
  }

  function download() {
    const blob = new Blob([editor.value], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zonepro-dashboard.yaml';
    a.click();
    URL.revokeObjectURL(url);
  }

  copyBtn.addEventListener('click', copy);
  downloadBtn.addEventListener('click', download);
  refreshBtn.addEventListener('click', load);

  load();
})();
