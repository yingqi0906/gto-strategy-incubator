/* ============================================================================
 * 大牌提示 · 圆角缎带  v1.0（2026-10-27 定稿）
 * ----------------------------------------------------------------------------
 * 依赖：assets/ui/rank-ribbon.css（或等价内联样式）。无其他依赖。
 *
 * 对外接口：
 *   RankRibbon.show(tier, opts?)          // tier 1~7，直接播一档
 *   RankRibbon.showByScore(score)         // 传 core.js 的 best7().score，自动去重
 *   RankRibbon.newHand()                  // 新一手开始，重置去重状态
 *   RankRibbon.build(tier, extraClass?)   // 返回 HTML 字符串（做一览表/调试用）
 *   RankRibbon.TIERS                      // 档位配置
 *
 * 与 core.js 的对接（只有 2 行改动）：
 *   const best = C.best7(me.hole.concat(board));
 *   RankRibbon.showByScore(best.score);            // ← 新增
 *   ... else 分支（翻牌前）：
 *   RankRibbon.newHand();                          // ← 新增
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 档位配置
   * w  = 缎带宽度（720 竖屏设计基准，1:1 像素）
   * fs = 牌型名字号
   * m  = 金属五段渐变：高光 / 亮面 / 主色 / 暗面 / 边沿
   * 装饰件：1 三点 · 2 阶梯斜纹 · 3 四花色 · 4 尖冠 · 5 红宝石+方铆钉
   *         6 冷蓝箭头 · 7 王冠 + 硬边星芒
   */
  var TIERS = {
    1: { name: '暗三条',     w: 340, fs: 56, m: ['#F3D0A8','#C99A63','#A87438','#7E501F','#5C3A15'] },
    2: { name: '顺子',       w: 300, fs: 60, m: ['#F6FAFD','#DCE5EC','#B4C2CE','#8798A6','#66757F'] },
    3: { name: '同花',       w: 300, fs: 60, m: ['#FFF3CE','#F0C860','#D9A441','#A87724','#7E5214'] },
    4: { name: '葫芦',       w: 300, fs: 60, m: ['#FFF8DE','#F7D780','#E2B14C','#B4812A','#8A5E19'] },
    5: { name: '金刚',       w: 300, fs: 60, m: ['#FFFAE4','#F9DA88','#E6B84F','#B9842C','#8A5E19'] },
    6: { name: '同花顺',     w: 340, fs: 56, m: ['#FFFFFF','#E6F0F9','#C2D6E6','#93AFC7','#6C8AA3'] },
    7: { name: '皇家同花顺', w: 470, fs: 46, m: ['#FFFDF2','#FFF0BC','#FFDD7E','#E0AC3E','#9C6C1C'] }
  };

  var SLOT_ID = 'rank-ribbon-slot';
  var state = { lastTier: 0, cards: [] };

  /* ---------- 装饰件 ---------- */
  function deco(tier, side) {
    if (tier === 1) return '<i class="rr-dot"></i><i class="rr-dot"></i><i class="rr-dot"></i>';
    if (tier === 2) return '<i class="rr-bar"></i><i class="rr-bar"></i><i class="rr-bar"></i>';
    if (tier === 3) return side === 'l'
      ? '<i class="rr-pip">♠</i><i class="rr-pip">♣</i>'
      : '<i class="rr-pip hot">♥</i><i class="rr-pip hot">♦</i>';
    if (tier === 5) return '<i class="rr-sq"></i><i class="rr-sq"></i>';
    if (tier === 6) return '<i class="rr-ar"></i>';
    return '';
  }

  /* ---------- 生成 DOM 字符串 ---------- */
  function build(tier, extraClass) {
    var t = TIERS[tier];
    if (!t) return '';
    var crown = (tier === 4 || tier === 7) ? '<i class="rr-crown"></i>' : '';
    var gem   = (tier === 5) ? '<i class="rr-gem"></i>' : '';
    var rays  = (tier === 7) ? '<i class="rr-rays"></i>' : '';
    var dgCls = 'rr-dg' + (tier === 3 ? ' row' : '');

    var style = '--rr-w:' + t.w + 'px;--rr-fs:' + t.fs + 'px;'
      + '--rr-m1:' + t.m[0] + ';--rr-m2:' + t.m[1] + ';--rr-m3:' + t.m[2]
      + ';--rr-m4:' + t.m[3] + ';--rr-m5:' + t.m[4] + ';';

    return '<div class="rr rr-t' + tier + (extraClass ? ' ' + extraClass : '') + '" style="' + style + '">'
      + rays
      + '<i class="rr-ring"></i>'
      + '<i class="rr-tail l"></i><i class="rr-tail r"></i>'
      + '<div class="rr-band"><div class="rr-fr"><div class="rr-fc">'
      +   '<i class="rr-sheen"></i>'
      +   '<i class="' + dgCls + ' l">' + deco(tier, 'l') + '</i>'
      +   '<i class="' + dgCls + ' r">' + deco(tier, 'r') + '</i>'
      +   '<div class="rr-word">'
      +     '<i class="rr-ol">' + t.name + '</i>'
      +     '<i class="rr-fl">' + t.name + '</i>'
      +     '<i class="rr-gl">' + t.name + '</i>'
      +   '</div>'
      + '</div></div></div>'
      + crown + gem
      + '</div>';
  }

  /* ---------- 播放 ---------- */
  function show(tier, opts) {
    var slot = document.getElementById(SLOT_ID);
    if (!slot || !TIERS[tier]) return false;

    opts = opts || {};
    slot.innerHTML = '';
    slot.insertAdjacentHTML('beforeend', build(tier, ''));
    var node = slot.lastElementChild;

    requestAnimationFrame(function () { node.classList.add('rr-on'); });
    node.addEventListener('animationend', function () {
      node.classList.remove('rr-on');
    }, { once: true });
    /* 低端机偶发 animationend 不触发，兜底清场 */
    setTimeout(function () {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }, 1100);

    var cards = opts.cards || state.cards;
    if (cards && cards.length) {
      cards.forEach(function (c) { if (c) c.classList.add('rr-lit'); });
      setTimeout(function () {
        cards.forEach(function (c) { if (c) c.classList.remove('rr-lit'); });
      }, 1000);
    }
    return true;
  }

  /* ---------- 由 core.js 的 score 数组映射档位 ----------
   * score[0]：0 高牌 1 一对 2 两对 3 三条 4 顺子 5 同花 6 葫芦 7 四条 8 同花顺
   * score[1]：同花顺时为首张点数（14 = A），与 core.js 的 handName 判定口径一致
   */
  function tierOf(score) {
    if (!score || typeof score[0] !== 'number') return 0;
    var c = score[0];
    if (c === 3) return 1;
    if (c === 4) return 2;
    if (c === 5) return 3;
    if (c === 6) return 4;
    if (c === 7) return 5;
    if (c === 8) return score[1] === 14 ? 7 : 6;
    return 0;
  }

  /* 同一手内：只在档位提升时弹一次（三条 → 转葫芦会再弹一次，符合"越打越大"的直觉） */
  function showByScore(score, opts) {
    var tier = tierOf(score);
    if (!tier) return false;
    if (tier <= state.lastTier) return false;
    state.lastTier = tier;
    return show(tier, opts);
  }

  function newHand() { state.lastTier = 0; }

  /* 把手牌元素登记进来，播提示时自动加金边（可选） */
  function setCards(els) { state.cards = els || []; }

  global.RankRibbon = {
    show: show,
    showByScore: showByScore,
    newHand: newHand,
    setCards: setCards,
    tierOf: tierOf,
    build: build,
    TIERS: TIERS,
    slotId: SLOT_ID
  };
})(typeof window !== 'undefined' ? window : this);
