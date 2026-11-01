/* ============================================================
   ambient.js —— 背景指针视差
   只更新 .bg-layer 上的 --parallax-x / --parallax-y 两个 CSS 变量，
   指针静止、页面隐藏或动效关闭时立即停止 rAF 循环。
   不接管系统光标：指针外观与交互反馈保持浏览器原生行为。
   ============================================================ */
(function (global) {
  'use strict';

  function mount(options) {
    options = options || {};
    var doc = global.document;
    var win = global;
    var body = doc && doc.body;
    var background = options.background || (doc && doc.querySelector('.bg-layer'));
    var enabled = options.enabled !== false;
    var destroyed = false;
    var listening = false;
    var frame = null;
    var lastTime = 0;
    var currentX = 0;
    var currentY = 0;
    var targetX = 0;
    var targetY = 0;
    var motionQuery = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    if (!body || !background) {
      return { setEnabled: function () {}, destroy: function () {} };
    }

    function canAnimate() {
      return enabled && !destroyed && !motionQuery.matches;
    }

    function resetParallax() {
      currentX = 0;
      currentY = 0;
      targetX = 0;
      targetY = 0;
      background.style.setProperty('--parallax-x', '0px');
      background.style.setProperty('--parallax-y', '0px');
    }

    function stopFrame() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      lastTime = 0;
    }

    function schedule() {
      if (frame === null && !doc.hidden && canAnimate()) frame = win.requestAnimationFrame(tick);
    }

    function tick(time) {
      frame = null;
      if (!canAnimate() || doc.hidden) { lastTime = 0; return; }

      /* 按真实帧间隔计算阻尼，60Hz / 120Hz 屏幕上缓动速度一致。 */
      var elapsed = lastTime ? Math.min(50, time - lastTime) : 16.67;
      lastTime = time;
      var ease = 1 - Math.exp(-elapsed / 115);
      currentX += (targetX - currentX) * ease;
      currentY += (targetY - currentY) * ease;

      background.style.setProperty('--parallax-x', currentX.toFixed(2) + 'px');
      background.style.setProperty('--parallax-y', currentY.toFixed(2) + 'px');

      var unsettled = Math.abs(targetX - currentX) > 0.02 || Math.abs(targetY - currentY) > 0.02;
      if (unsettled) schedule();
      else lastTime = 0;
    }

    function onPointerMove(event) {
      if (!canAnimate()) return;
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

      var width = Math.max(1, win.innerWidth);
      var height = Math.max(1, win.innerHeight);
      /* 反向轻移形成景深；最大 10px / 8px，不影响背景主体构图。 */
      targetX = (0.5 - event.clientX / width) * 20;
      targetY = (0.5 - event.clientY / height) * 16;
      schedule();
    }

    function recenter() {
      targetX = 0;
      targetY = 0;
      schedule();
    }

    function onVisibilityChange() {
      body.classList.toggle('page-hidden', doc.hidden);
      if (doc.hidden) stopFrame();
      else lastTime = 0;
    }

    function setPointerListeners(active) {
      if (active === listening) return;
      listening = active;
      var method = active ? 'addEventListener' : 'removeEventListener';
      doc[method]('pointermove', onPointerMove, { passive: true });
      doc[method]('pointerout', onPointerOut, { passive: true });
      doc[method]('pointercancel', recenter, { passive: true });
      win[method]('blur', recenter);
    }

    function onPointerOut(event) {
      if (event.relatedTarget) return;
      recenter();
    }

    function sync() {
      var active = canAnimate();
      body.classList.toggle('ambient-motion', active);
      body.classList.toggle('page-hidden', doc.hidden);
      setPointerListeners(active);
      if (!active) {
        stopFrame();
        resetParallax();
      }
    }

    function onMediaChange() { sync(); }
    function listenMedia(query) {
      if (query.addEventListener) query.addEventListener('change', onMediaChange);
      else if (query.addListener) query.addListener(onMediaChange);
    }
    function unlistenMedia(query) {
      if (query.removeEventListener) query.removeEventListener('change', onMediaChange);
      else if (query.removeListener) query.removeListener(onMediaChange);
    }

    doc.addEventListener('visibilitychange', onVisibilityChange);
    listenMedia(motionQuery);
    sync();

    return {
      setEnabled: function (value) {
        enabled = value !== false;
        sync();
      },
      destroy: function () {
        destroyed = true;
        stopFrame();
        setPointerListeners(false);
        resetParallax();
        body.classList.remove('ambient-motion', 'page-hidden');
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        unlistenMedia(motionQuery);
      }
    };
  }

  global.AmbientMotion = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
