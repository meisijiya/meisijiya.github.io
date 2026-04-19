document.addEventListener('DOMContentLoaded', () => {
  const copyIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" height="14" width="15" viewBox="0 0 24 24" fill="white">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 18H8V7h11v16z"/>
    </svg>
  `;

  const checkIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" height="14" width="15" viewBox="0 0 24 24" fill="#00cc66">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
    </svg>
  `;

  document.querySelectorAll('figure.highlight').forEach((figure) => {
    if (figure.querySelector('.copy-btn')) return;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = '复制';
    copyBtn.innerHTML = copyIcon;

    Object.assign(copyBtn.style, {
      position: 'absolute',
      right: '8px',
      top: '8px',
      width: '28px',
      height: '28px',
      padding: '0',
      background: 'rgba(0, 0, 0, 0.3)',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      opacity: '0.85',
      zIndex: 99,
      transition: 'opacity 0.2s ease, background 0.2s ease',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });

    figure.style.position = 'relative';
    figure.appendChild(copyBtn);
  });

  document.querySelectorAll('.copy-btn').forEach((copyBtn) => {
    copyBtn.addEventListener('mouseover', () => {
      copyBtn.style.opacity = '1';
      copyBtn.style.background = 'rgba(0, 0, 0, 0.5)';
    });
    copyBtn.addEventListener('mouseout', () => {
      copyBtn.style.opacity = '0.85';
      copyBtn.style.background = 'rgba(0, 0, 0, 0.3)';
    });

    copyBtn.addEventListener('click', () => {
      const figure = copyBtn.parentElement;
      const code = figure.querySelector('td.code');
      const text = code ? code.innerText : '';
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = checkIcon;
        copyBtn.style.background = 'rgba(0, 200, 100, 0.4)';
        setTimeout(() => {
          copyBtn.innerHTML = copyIcon;
          copyBtn.style.background = 'rgba(0, 0, 0, 0.3)';
        }, 1000);
      });
    });
  });
});
