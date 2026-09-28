// 共享交互：数字滚动 + 入场浮现 + 主题切换（尊重 reduced-motion；不可见渲染器保持服务端渲染值）
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const showAll = () => document.querySelectorAll('.reveal:not(.in)').forEach(r => r.classList.add('in'));
  try {
    // 主题切换：记录偏好并刷新（图表等按新主题重绘）
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) themeBtn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      document.documentElement.dataset.theme = next;
      location.reload();
    });

    // 数字滚动：服务端已渲染最终值，仅在页面可见时重播 0→目标 动画
    const nums = document.querySelectorAll('[data-count]');
    if (nums.length && !reduce && !document.hidden) {
      const io = new IntersectionObserver(es => {
        es.forEach(e => {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          const el = e.target, target = parseFloat(el.dataset.count) || 0;
          const t0 = performance.now(), dur = 900;
          (function tick(t) {
            const k = Math.min(1, (t - t0) / dur), eased = 1 - Math.pow(1 - k, 3);
            el.textContent = (target * eased).toFixed(target % 1 ? 1 : 0);
            if (k < 1) requestAnimationFrame(tick);
          })(t0);
        });
      }, { threshold: .4 });
      nums.forEach(n => io.observe(n));
    }
    // 入场浮现：仅 html.anim（渲染器可见）时才有初始隐藏态，进入视口时上浮
    const rev = document.querySelectorAll('.reveal');
    if (rev.length && !reduce && 'IntersectionObserver' in window) {
      const io2 = new IntersectionObserver(es => {
        es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io2.unobserve(e.target); } });
      }, { threshold: .12 });
      rev.forEach(r => io2.observe(r));
    } else {
      showAll();
    }
  } catch (err) {
    showAll(); // 任何异常都兜底：内容必须可见
  }
})();
