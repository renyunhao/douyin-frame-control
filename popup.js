/**
 * 抖音逐帧控制 - Popup Script
 */

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  checkVideoStatus();
  bindEvents();
});

function bindEvents() {
  document.getElementById('togglePanel').addEventListener('click', togglePanel);
  document.getElementById('resetPosition').addEventListener('click', resetPosition);
}

async function checkVideoStatus() {
  try {
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      updateStatus(false);
      return;
    }

    // 注入脚本检查视频状态
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const video = document.querySelector('video');
        return {
          hasVideo: !!video,
          currentTime: video?.currentTime || 0,
          duration: video?.duration || 0
        };
      }
    });

    if (results[0]?.result?.hasVideo) {
      updateStatus(true);
    } else {
      updateStatus(false);
    }
  } catch (error) {
    console.error('检查状态失败:', error);
    updateStatus(false);
  }
}

function updateStatus(hasVideo) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  if (hasVideo) {
    dot.classList.add('active');
    text.textContent = '视频已就绪';
  } else {
    dot.classList.remove('active');
    text.textContent = '未检测到视频';
  }
}

async function togglePanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const panel = document.getElementById('frame-control-panel');
        if (panel) {
          panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        }
      }
    });

    window.close();
  } catch (error) {
    console.error('切换面板失败:', error);
  }
}

async function resetPosition() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.douyinFrameControl && window.douyinFrameControl.resetPanelPosition) {
          window.douyinFrameControl.resetPanelPosition();
        }
      }
    });

    window.close();
  } catch (error) {
    console.error('重置位置失败:', error);
  }
}