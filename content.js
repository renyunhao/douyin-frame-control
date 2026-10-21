/**
 * 抖音视频逐帧控制 - Content Script
 * 注入到抖音页面，劫持视频播放器控制
 */

(function() {
  'use strict';

  console.log('[逐帧控制] Content script loaded');

  // 状态管理
  let videoElement = null;
  let controlPanel = null;
  let isFrameStepping = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let panelPosition = { x: null, y: null }; // null 表示使用默认位置
  let isPausedByUser = false; // 用户主动暂停状态
  let seekPreventAutoPlay = false; // 阻止跳转后自动播放
  let isUserControlling = false; // 标记：用户主动修改播放状态，事件监听器应该忽略

  // 帧步进精度（秒）- 可以调整
  const FRAME_STEP = 0.04; // 约 25fps，一帧

  /**
   * 元素在视口内的可见面积
   */
  function visibleArea(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 0;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return 0;
    const w = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const h = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * 选出当前应该控制的视频：视口内面积最大的那个，其次是在播的那个。
   * 抖音的网格卡片/预加载 video 排在 DOM 前面，所以不能再用 querySelector('video')。
   */
  function pickActiveVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    let best = null;
    let bestArea = 0;
    for (const video of videos) {
      const area = visibleArea(video);
      if (area > bestArea) {
        bestArea = area;
        best = video;
      }
    }
    if (best) return best;

    // 全都不可见时（例如后台标签页），退回在播的那个
    return videos.find(v => !v.paused && !v.ended) || null;
  }

  /**
   * 找到只包住这一个 video 的最小容器，用来定位它自己的标题
   */
  function getPlayerContainer(video) {
    let node = video.parentElement;
    let last = node;
    while (node && node !== document.body && node.querySelectorAll('video').length === 1) {
      last = node;
      node = node.parentElement;
    }
    return last || document;
  }

  /**
   * 取当前控制目标的标题，尽力而为，失败则留空
   */
  function getVideoLabel(video) {
    const scope = getPlayerContainer(video);
    // 按可信度依次找；超过 120 字的肯定是把侧栏/评论一起吞进来的容器，跳过
    for (const selector of ['h1', '[data-e2e*="desc"]', '[class*="title"]', '[class*="desc"]']) {
      for (const el of scope.querySelectorAll(selector)) {
        const text = el.textContent?.trim();
        if (text && text.length > 2 && text.length <= 120) return text;
      }
    }
    return document.title.replace(/\s*[-–—]\s*抖音.*$/, '').trim();
  }

  /**
   * 创建控制面板 UI
   */
  function createControlPanel() {
    if (controlPanel) {
      return; // 已有控制面板
    }

    const panel = document.createElement('div');
    panel.id = 'frame-control-panel';
    panel.innerHTML = `
      <div class="frame-control-drag-handle" id="drag-handle" title="拖动我移动面板">
        <span class="drag-dots">⋮⋮</span>
      </div>
      <div class="frame-control-group">
        <button id="frame-prev" title="后退一帧">⏮ -1帧<span class="key-badge">D</span></button>
        <button id="frame-next" title="前进一帧">⏭ +1帧<span class="key-badge">F</span></button>
        <button id="screenshot" title="截图当前帧" class="secondary-btn">📷<span class="key-badge">G</span></button>
      </div>
      <div class="frame-control-info">
        <span id="video-info">未选中视频</span>
        <span id="frame-info">帧: 0</span>
      </div>
    `;

    // 样式
    panel.style.cssText = `
      position: fixed;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.85);
      padding: 12px 20px 12px 12px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      user-select: none;
    `;

    // 拖拽手柄样式
    const handle = panel.querySelector('#drag-handle');
    handle.style.cssText = `
      cursor: grab;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      font-size: 16px;
      color: rgba(255, 255, 255, 0.6);
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, color 0.2s;
    `;
    handle.addEventListener('mouseenter', () => {
      handle.style.background = 'rgba(255, 255, 255, 0.2)';
      handle.style.color = 'rgba(255, 255, 255, 0.9)';
    });
    handle.addEventListener('mouseleave', () => {
      if (!isDragging) {
        handle.style.background = 'rgba(255, 255, 255, 0.1)';
        handle.style.color = 'rgba(255, 255, 255, 0.6)';
      }
    });
    handle.addEventListener('mousedown', () => {
      handle.style.cursor = 'grabbing';
    });

    document.body.appendChild(panel);
    controlPanel = panel;

    // 设置初始位置
    setPanelPosition();

    // 初始化拖拽
    initDragFunctionality(panel, handle);

    // 绑定按钮事件
    panel.querySelector('#frame-prev').addEventListener('click', () => {
      stepFrame(-1);
    });

    panel.querySelector('#frame-next').addEventListener('click', () => {
      stepFrame(1);
    });

    // 绑定截图按钮
    const screenshotBtn = panel.querySelector('#screenshot');
    screenshotBtn.addEventListener('click', () => {
      captureFrame();
    });

    // 初始化键盘快捷键
    initKeyboardShortcuts(panel);

    console.log('[逐帧控制] 控制面板已创建');
  }

  /**
   * 帧步进控制
   * @param {number} direction - 方向，1为前进，-1为后退
   */
  async function stepFrame(direction) {
    if (!videoElement || isFrameStepping) return;

    isFrameStepping = true;

    try {
      const currentTime = videoElement.currentTime;
      const duration = videoElement.duration;

      // 计算目标时间
      let targetTime = currentTime + (direction * FRAME_STEP);

      // 边界检查
      if (targetTime < 0) targetTime = 0;
      if (targetTime > duration) targetTime = duration;

      // 方法1: 直接设置时间
      videoElement.currentTime = targetTime;

      // 等待一帧渲染
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      // 更新显示
      updateFrameDisplay();

      console.log(`[逐帧控制] ${direction > 0 ? '前进' : '后退'}到: ${targetTime.toFixed(3)}s`);

    } catch (error) {
      console.error('[逐帧控制] 步进失败:', error);
    } finally {
      isFrameStepping = false;
    }
  }

  /**
   * 更新面板上显示的控制目标信息
   */
  function updateVideoInfo() {
    if (!controlPanel) return;
    const el = controlPanel.querySelector('#video-info');
    if (!el) return;

    if (!videoElement) {
      el.textContent = '未选中视频';
      el.removeAttribute('title');
      return;
    }

    const label = getVideoLabel(videoElement);
    const dims = videoElement.videoWidth ? `${videoElement.videoWidth}x${videoElement.videoHeight}` : '未解码';
    el.textContent = `${label ? label + ' · ' : ''}${dims}`;
    el.title = [label, dims, videoElement.currentSrc || videoElement.src].filter(Boolean).join('\n');
  }

  /**
   * 更新帧显示信息
   */
  function updateFrameDisplay() {
    if (!videoElement || !controlPanel) return;

    const frameInfo = controlPanel.querySelector('#frame-info');
    const currentFrame = Math.floor(videoElement.currentTime / FRAME_STEP);

    frameInfo.textContent = `帧: ${currentFrame} | ${videoElement.currentTime.toFixed(3)}s / ${videoElement.duration?.toFixed(3) || '?'}s`;
  }

  /**
   * 设置面板位置（使用存储的位置或默认位置）
   */
  function setPanelPosition() {
    if (!controlPanel) return;

    // 优先使用存储的位置
    if (panelPosition.x !== null && panelPosition.y !== null) {
      controlPanel.style.left = `${panelPosition.x}px`;
      controlPanel.style.top = `${panelPosition.y}px`;
      controlPanel.style.bottom = 'auto';
      controlPanel.style.right = 'auto';
      controlPanel.style.transform = 'none';
    } else {
      // 默认位置：底部居中
      controlPanel.style.bottom = '20px';
      controlPanel.style.left = '50%';
      controlPanel.style.top = 'auto';
      controlPanel.style.right = 'auto';
      controlPanel.style.transform = 'translateX(-50%)';
    }
  }

  /**
   * 初始化拖拽功能
   */
  function initDragFunctionality(panel, handle) {
    // 鼠标按下，开始拖拽
    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: false });

    function startDrag(e) {
      e.preventDefault();
      isDragging = true;

      const event = e.type === 'touchstart' ? e.touches[0] : e;
      const rect = panel.getBoundingClientRect();

      // 计算鼠标相对于面板左上角的偏移
      dragOffset.x = event.clientX - rect.left;
      dragOffset.y = event.clientY - rect.top;

      // 切换为绝对定位（保留当前位置）
      panel.style.transform = 'none';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';

      // 添加拖拽中的样式
      panel.style.boxShadow = '0 8px 30px rgba(0, 0, 0, 0.5)';
      panel.style.opacity = '0.95';

      // 绑定移动和释放事件（到 document 上，以便鼠标移出面板也能响应）
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', endDrag);
      document.addEventListener('touchmove', onDrag, { passive: false });
      document.addEventListener('touchend', endDrag);
    }

    function onDrag(e) {
      if (!isDragging) return;
      e.preventDefault();

      const event = e.type === 'touchmove' ? e.touches[0] : e;

      // 计算新位置
      let newX = event.clientX - dragOffset.x;
      let newY = event.clientY - dragOffset.y;

      // 边界限制（保证面板至少有一部分在屏幕内）
      const panelRect = panel.getBoundingClientRect();
      const maxX = window.innerWidth - 40; // 至少留 40px 可见
      const maxY = window.innerHeight - 40;
      const minX = -(panelRect.width - 40);
      const minY = 0;

      newX = Math.max(minX, Math.min(newX, maxX));
      newY = Math.max(minY, Math.min(newY, maxY));

      panel.style.left = `${newX}px`;
      panel.style.top = `${newY}px`;
    }

    function endDrag(e) {
      if (!isDragging) return;
      isDragging = false;

      // 保存位置
      const rect = panel.getBoundingClientRect();
      panelPosition.x = rect.left;
      panelPosition.y = rect.top;
      savePosition();

      // 恢复样式
      panel.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
      panel.style.opacity = '1';
      handle.style.cursor = 'grab';

      // 移除事件监听
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('touchmove', onDrag);
      document.removeEventListener('touchend', endDrag);
    }
  }

  /**
   * 保存面板位置到 localStorage
   */
  function savePosition() {
    try {
      localStorage.setItem('douyin-frame-control-pos', JSON.stringify(panelPosition));
    } catch (e) {
      console.warn('[逐帧控制] 无法保存位置:', e);
    }
  }

  /**
   * 从 localStorage 加载面板位置
   */
  function loadPosition() {
    try {
      const saved = localStorage.getItem('douyin-frame-control-pos');
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === 'number' && typeof pos.y === 'number') {
          panelPosition = pos;
          return true;
        }
      }
    } catch (e) {
      console.warn('[逐帧控制] 无法加载位置:', e);
    }
    return false;
  }

  /**
   * 重置面板位置到默认
   */
  function resetPosition() {
    panelPosition = { x: null, y: null };
    try {
      localStorage.removeItem('douyin-frame-control-pos');
    } catch (e) {}
    setPanelPosition();
  }

  /**
   * 设置暂停状态（用户主动暂停）
   */
  function setPauseState(pause) {
    if (!videoElement) return;
    if (pause) {
      videoElement.pause();
      isPausedByUser = true;
      seekPreventAutoPlay = false;
    } else {
      videoElement.play();
      isPausedByUser = false;
    }
  }

  /**
   * 切换暂停/播放状态
   */
  function togglePause() {
    if (!videoElement) return;

    // 设置控制锁，告诉事件监听器这是用户主动操作
    isUserControlling = true;

    if (videoElement.paused) {
      videoElement.play();
      isPausedByUser = false;
    } else {
      videoElement.pause();
      isPausedByUser = true;
    }

    // 立即释放锁（异步，保证事件监听器看到锁）
    setTimeout(() => {
      isUserControlling = false;
    }, 10);
  }

  /**
   * 截图当前视频帧
   */
  function captureFrame() {
    if (!videoElement) {
      console.warn('[逐帧控制] 未找到视频元素');
      return;
    }

    try {
      // 创建 Canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // 设置 canvas 尺寸为视频的实际分辨率
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;

      // 如果视频分辨率不可用，使用当前显示尺寸
      if (canvas.width === 0 || canvas.height === 0) {
        const rect = videoElement.getBoundingClientRect();
        canvas.width = Math.floor(rect.width);
        canvas.height = Math.floor(rect.height);
      }

      // 绘制当前帧
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

      // 转换为图片并下载
      const timestamp = new Date().getTime();
      const filename = `douyin-frame-${timestamp}.png`;

      // 创建下载链接
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      link.click();

      console.log(`[逐帧控制] 已截图: ${filename}`);

      // 显示截图反馈
      showScreenshotFeedback(canvas);

    } catch (error) {
      console.error('[逐帧控制] 截图失败:', error);
      alert('截图失败，请确保视频已加载');
    }
  }

  /**
   * 显示截图反馈动画
   */
  function showScreenshotFeedback(canvas) {
    const feedback = document.createElement('div');
    feedback.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 1000000;
      padding: 12px 24px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      border-radius: 8px;
      font-size: 14px;
      pointer-events: none;
      animation: fade-out 1.5s ease-out forwards;
    `;

    // 创建一个预览缩略图
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 120;
    previewCanvas.height = 68;
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

    feedback.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="background: #fff; border-radius: 4px; overflow: hidden;">
          ${previewCanvas.outerHTML}
        </div>
        <div>已保存当前帧</div>
      </div>
      <style>
        @keyframes fade-out {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(1.1); }
        }
      </style>
    `;

    document.body.appendChild(feedback);

    setTimeout(() => {
      feedback.remove();
    }, 1500);
  }

  /**
   * 给视频元素绑定事件（每个元素只绑一次）
   */
  const boundVideos = new WeakSet();

  function bindVideoEvents(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);

    video.addEventListener('timeupdate', updateFrameDisplay);
    video.addEventListener('ended', updateVideoInfo);

    // 监听暂停事件，记录用户主动暂停状态
    video.addEventListener('pause', () => {
      // 如果是用户主动操作或正在步进，忽略
      if (isUserControlling || isFrameStepping) return;
      isPausedByUser = true;
    });

    // 监听播放事件
    video.addEventListener('play', () => {
      // 如果是用户主动操作，忽略
      if (isUserControlling) return;

      // 只在跳转状态且用户之前暂停时强制暂停
      if (seekPreventAutoPlay && isPausedByUser) {
        video.pause();
        seekPreventAutoPlay = false;
        return;
      }

      // 否则更新暂停状态
      if (!seekPreventAutoPlay) {
        isPausedByUser = false;
      }
    });

    // 监听视频开始加载（新的视频）
    video.addEventListener('loadeddata', () => {
      // 重置状态
      seekPreventAutoPlay = false;
      updateVideoInfo();
    });

    // 监听进度条点击（input 事件通常用于进度条）
    video.addEventListener('seeking', () => {
      // 视频开始跳转
      if (isPausedByUser) {
        seekPreventAutoPlay = true;
      }
    });

    // 监听跳转完成
    video.addEventListener('seeked', () => {
      // 跳转完成后，如果用户之前是暂停状态，强制暂停
      if (seekPreventAutoPlay && isPausedByUser) {
        video.pause();
        seekPreventAutoPlay = false;
      }
    });
  }

  /**
   * 切换控制目标
   */
  let lastTargetSrc = '';

  function setTarget(video, reason) {
    if (!video) return;
    const switched = video !== videoElement;
    videoElement = video;
    bindVideoEvents(video);

    if (!controlPanel) {
      createControlPanel();
    }

    if (switched) {
      // 换目标后旧视频的暂停状态不再适用
      isPausedByUser = video.paused;
      seekPreventAutoPlay = false;
      console.log('[逐帧控制] 控制目标已切换（' + reason + '）:', video);
      showShortcutHint(controlPanel, '已切换控制目标');
    }

    // 同一个 video 节点换源（弹层复用播放器）也要刷新显示，否则标题停留在上一条视频
    const src = video.currentSrc || video.src || '';
    if (switched || src !== lastTargetSrc) {
      lastTargetSrc = src;
      updateVideoInfo();
    }

    updateFrameDisplay();
  }

  function checkVideo(reason) {
    const video = pickActiveVideo();
    if (video) setTarget(video, reason);
  }

  /**
   * 初始化观察器，监听视频元素变化
   */
  function initObserver() {
    // 兜底轮询：抖音有时不派发我们监听的变化
    const pollInterval = setInterval(() => checkVideo('轮询'), 1000);

    // 弹层打开/关闭、卡片替换 video 都会改 DOM，比 1s 轮询及时得多
    let mutationTimer = null;
    const observer = new MutationObserver(() => {
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        checkVideo('DOM 变化');
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 点击卡片打开弹层这类操作，立刻重扫一次，不等 250ms 防抖
    document.addEventListener('click', () => checkVideo('点击'), { capture: true });

    // 首次立即扫一遍，不用等 1 秒
    checkVideo('初始');

    // 页面卸载时清理
    window.addEventListener('unload', () => {
      clearInterval(pollInterval);
      observer.disconnect();
      clearTimeout(mutationTimer);
      if (controlPanel) {
        controlPanel.remove();
        controlPanel = null;
      }
    });
  }

  // 启动
  loadPosition(); // 加载保存的位置
  initObserver();

  /**
   * 初始化键盘快捷键
   */
  function initKeyboardShortcuts(panel) {
    // 在 CAPTURE 阶段监听，优先级最高，防止抖音播放器响应这些键
    document.addEventListener('keydown', function handleKeyDown(e) {
      // 如果在输入框中，不触发
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      let shouldIntercept = false;

      switch (e.key) {
        case 'ArrowRight':
        case 'f':
        case 'F':
          shouldIntercept = true;
          stepFrame(1);
          showShortcutHint(panel, '前进一帧 ⏭');
          break;
        case 'ArrowLeft':
        case 'd':
        case 'D':
          shouldIntercept = true;
          stepFrame(-1);
          showShortcutHint(panel, '后退一帧 ⏮');
          break;
        case ' ':
          shouldIntercept = true;
          if (videoElement) {
            togglePause();
          }
          showShortcutHint(panel, videoElement?.paused ? '播放 ▶' : '暂停 ⏸');
          break;
        case 'g':
        case 'G':
          shouldIntercept = true;
          captureFrame();
          showShortcutHint(panel, '已截图 📷');
          break;
      }

      // 如果我们处理了这个键，彻底阻止其他处理
      if (shouldIntercept) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  /**
   * 显示快捷键提示
   */
  function showShortcutHint(panel, message) {
    let hint = document.getElementById('frame-control-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'frame-control-hint';
      document.body.appendChild(hint);
    }

    hint.textContent = message;
    hint.classList.add('visible');

    clearTimeout(hint.hideTimeout);
    hint.hideTimeout = setTimeout(() => {
      hint.classList.remove('visible');
    }, 1000);
  }

  // 暴露 API 到 window，供测试用
  window.douyinFrameControl = {
    stepFrame,
    getVideoElement: () => videoElement,
    getCurrentTime: () => videoElement?.currentTime || 0,
    resetPanelPosition: resetPosition,
    getPanelPosition: () => ({ ...panelPosition }),
    setPauseState,
    togglePause,
    captureFrame,
    rescan: () => { checkVideo('手动'); return videoElement; },
    getTargetInfo: () => videoElement ? {
      label: getVideoLabel(videoElement),
      size: `${videoElement.videoWidth}x${videoElement.videoHeight}`,
      duration: videoElement.duration,
      src: videoElement.currentSrc || videoElement.src,
      visibleArea: visibleArea(videoElement),
      video: videoElement
    } : null,
    listCandidates: () => Array.from(document.querySelectorAll('video')).map(v => ({
      area: visibleArea(v),
      size: `${v.videoWidth}x${v.videoHeight}`,
      src: (v.currentSrc || v.src || '').slice(0, 60),
      isActive: v === videoElement,
      video: v
    }))
  };

})();