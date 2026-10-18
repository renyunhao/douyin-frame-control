// 调试脚本：在页面最开始运行
(function() {
  'use strict';

  console.log('[逐帧调试] 调试脚本加载');

  // 在 capture 阶段监听所有 keydown
  document.addEventListener('keydown', function(e) {
    console.log('[KEYDOWN capture] Key:', e.key, 'Code:', e.code, 'Target:', e.target.tagName);

    // 检查是否有默认行为
    if (e.defaultPrevented) {
      console.log('[KEYDOWN] Default already prevented');
    }
  }, { capture: true });

  // 监听空格键
  document.addEventListener('keydown', function(e) {
    if (e.key === ' ' || e.code === 'Space') {
      console.log('[SPACE KEYDOWN] Preventing...');
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  console.log('[逐帧调试] 调试脚本注入完成');
})();
