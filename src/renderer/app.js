// MC启动器 — 界面逻辑
//
// 当前进度：M1（界面骨架）。只负责一件事：顶栏三个按钮切换页面。
// 页面里的功能会从 M2 开始一步步填进来。

// ——————————————————————————————————————————————
// 页面切换
// ——————————————————————————————————————————————

const navButtons = document.querySelectorAll('.nav__btn')
const pages = document.querySelectorAll('.page')

function showPage(name) {
  for (const button of navButtons) {
    button.classList.toggle('nav__btn--on', button.dataset.page === name)
  }
  for (const page of pages) {
    page.hidden = page.dataset.page !== name
  }
}

for (const button of navButtons) {
  button.addEventListener('click', () => showPage(button.dataset.page))
}

// 打开时默认停在「启动」页
showPage('launch')

// ——————————————————————————————————————————————
// 版本号
// ——————————————————————————————————————————————

document.getElementById('stat-left').textContent =
  `版本 ${window.api?.appVersion ?? '未知'}`
