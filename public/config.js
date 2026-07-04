(() => {
  const editor = document.getElementById('editor');
  const saveBtn = document.getElementById('saveBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const statusMsg = document.getElementById('statusMsg');
  const backupsList = document.getElementById('backupsList');

  function setStatus(text, kind) {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg ${kind || ''}`.trim();
  }

  async function loadCurrent() {
    setStatus('Laden\u2026', '');
    try {
      const res = await fetch('/api/config/raw');
      editor.value = await res.text();
      editor.classList.remove('has-error');
      setStatus('', '');
    } catch (err) {
      setStatus(`Kon config.json niet laden: ${err.message}`, 'err');
    }
  }

  async function save() {
    saveBtn.disabled = true;
    setStatus('Opslaan\u2026', '');
    try {
      const res = await fetch('/api/config/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: editor.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        editor.classList.add('has-error');
        setStatus(data.error || 'Opslaan mislukt.', 'err');
        return;
      }
      editor.classList.remove('has-error');
      setStatus('Opgeslagen.', 'ok');
      loadBackups();
    } catch (err) {
      setStatus(`Opslaan mislukt: ${err.message}`, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  async function loadBackups() {
    try {
      const res = await fetch('/api/config/backups');
      const files = await res.json();
      backupsList.innerHTML = '';

      if (files.length === 0) {
        const li = document.createElement('li');
        li.className = 'backups-empty';
        li.textContent = 'Nog geen backups.';
        backupsList.appendChild(li);
        return;
      }

      for (const f of files) {
        const li = document.createElement('li');
        li.className = 'backup-row';

        const time = document.createElement('span');
        time.className = 'backup-time';
        time.textContent = formatTime(f.mtime);

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn backup-restore';
        restoreBtn.type = 'button';
        restoreBtn.textContent = 'Terugzetten in editor';
        restoreBtn.addEventListener('click', async () => {
          const r = await fetch(`/api/config/backups/${encodeURIComponent(f.file)}`);
          if (r.ok) {
            editor.value = await r.text();
            editor.classList.remove('has-error');
            setStatus('Backup in editor geplaatst \u2014 klik Opslaan om toe te passen.', '');
          }
        });

        li.appendChild(time);
        li.appendChild(restoreBtn);
        backupsList.appendChild(li);
      }
    } catch (err) {
      backupsList.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'backups-empty';
      li.textContent = `Kon backups niet laden: ${err.message}`;
      backupsList.appendChild(li);
    }
  }

  // Tab key inserts a real tab instead of moving focus out of the editor.
  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
  });

  saveBtn.addEventListener('click', save);
  reloadBtn.addEventListener('click', loadCurrent);

  loadCurrent();
  loadBackups();
})();
