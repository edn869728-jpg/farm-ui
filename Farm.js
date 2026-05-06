/**
 * =========================
 * Farm.gs 相容包裝
 * =========================
 * 農場規則與農場 API 已獨立放這個檔案。
 * Code.gs 只保留會員主表 / LINE / POS / 點數等核心邏輯。
 *
 * 注意：
 * 1. 本檔自己的農場 function 已移除尾巴 _
 * 2. Code.gs 共用工具 function 例如 clean_、openSS_、initSystem_ 保留不動
 */

/**
 * 舊版 getFarm 相容入口
 */
function getFarmData(data) {
  return getFarmBootstrap(data || {});
}

/**
 * 舊版 saveFarm 相容入口
 */
function saveFarmData(data) {
  data = data || {};
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const memberId = clean_(data.member_id);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  let farm = data.farm || data.farm_json || data.farmJson || null;

  if (typeof farm === 'string') {
    try {
      farm = JSON.parse(farm);
    } catch (err) {
      return {
        ok: false,
        message: 'farm_json 格式錯誤'
      };
    }
  }

  if (!farm) {
    return {
      ok: false,
      message: '缺少 farm 資料'
    };
  }

  const hit = findMemberByLineUserId_(lineUserId);
  const finalMemberId = memberId || (hit.ok ? hit.member.member_id : '');

  saveFarmState(lineUserId, finalMemberId, farm);

  return {
    ok: true,
    message: '農場資料已儲存',
    farm: normalizeFarmState(farm)
  };
}

/**
 * =========================
 * Farmmember 農場遊戲 API
 * =========================
 */

const SHEET_FARM_DATA = 'farm_data';
const SHEET_FARM_LOG = 'farm_log';

const FARM_HEADERS = [
  'line_user_id',
  'member_id',
  'Game_Point',
  'plots_json',
  'farm_json',
  'last_calc_date',
  'last_water_date',
  'update_time'
];

const FARM_LOG_HEADERS = [
  'time',
  'line_user_id',
  'member_id',
  'action',
  'crop',
  'plot_index',
  'cost',
  'point_after',
  'message'
];

const FARM_PLOT_COUNT = 15;
const FARM_REWARD_NEED = 20;
const FARM_BASE_GROW_POINT = 5;
const FARM_WATER_GROW_POINT = 7.5;

function farmApi(data) {
  data = data || {};
  const action = clean_(data.action);

  if (action === 'getFarmBootstrap') {
    return getFarmBootstrap(data);
  }

  if (action === 'farmPlant') {
    return farmPlant(data);
  }

  if (action === 'farmWater') {
    return farmWater(data);
  }

  if (action === 'farmHarvest') {
    return farmHarvest(data);
  }

  if (action === 'farmRedeemCoupon') {
    return farmRedeemCoupon(data);
  }

  if (action === 'shopBuy') {
    return farmShopBuy(data);
  }

  if (action === 'linkByPhone') {
    return farmLinkByPhone(data);
  }

  return {
    ok: false,
    message: '未知 farm action：' + action
  };
}

/**
 * 用電話號碼綁定 LINE user ID
 * 找到舊會員就綁定，找不到就建立或更新 line_only 會員
 */
function farmLinkByPhone(data) {
  initSystem_();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const phoneRaw = clean_(data.phone);
  const lineName = clean_(data.line_name || 'LINE會員');

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  if (!phoneRaw) {
    return {
      ok: false,
      message: '請輸入電話號碼'
    };
  }

  const phoneInfo = normalizePhoneWithRule_(phoneRaw);

  if (phoneInfo.phone_status !== 'valid') {
    return {
      ok: false,
      message: '電話格式不正確，請重新輸入，例如 0912345678'
    };
  }

  const ss = openSS_();
  const sh = getOrCreateSheet_(ss, SHEET_MEMBERS);

  ensureMainMemberSheet_(ss);

  const rows = getMainMemberObjects_(sh);
  const tempHit = findMemberByLineUserId_(lineUserId);

  const phoneHits = rows.filter(function(row) {
    return clean_(row.phone_normalized) === phoneInfo.phone_normalized;
  });

  if (phoneHits.length > 1) {
    return {
      ok: false,
      message: '同電話對到多筆會員，請人工確認'
    };
  }

  let member;

  if (phoneHits.length > 0) {
    member = phoneHits[0];

    const oldLineUserId = clean_(member.line_user_id);

    if (oldLineUserId && oldLineUserId !== lineUserId && isRealLineUserId_(oldLineUserId)) {
      return {
        ok: false,
        message: '此電話已綁定其他 LINE 帳號，請人工確認'
      };
    }

    const patch = buildUpsertPatch_(
      member,
      {
        line_user_id: lineUserId,
        line_name: lineName,
        member_source: getSetting_('linked_source', 'linked'),
        link_status: 'linked'
      },
      phoneRaw,
      phoneInfo,
      clean_(member.name || member.line_name || lineName || 'LINE會員'),
      lineUserId
    );

    setMemberObjectToRow_(sh, member.__rowIndex, patch);

    if (tempHit.ok && tempHit.rowIndex !== member.__rowIndex) {
      sh.deleteRow(tempHit.rowIndex);
    }
  } else {
    if (tempHit.ok) {
      const patch = buildUpsertPatch_(
        tempHit.member,
        {
          line_user_id: lineUserId,
          line_name: lineName,
          member_source: getSetting_('linked_source', 'linked'),
          link_status: 'linked'
        },
        phoneRaw,
        phoneInfo,
        clean_(tempHit.member.name || tempHit.member.line_name || lineName || 'LINE會員'),
        lineUserId
      );

      setMemberObjectToRow_(sh, tempHit.rowIndex, patch);
      member = readMemberObjectAtRow_(sh, tempHit.rowIndex);
    } else {
      const res = upsertMainMember_({
        line_user_id: lineUserId,
        line_name: lineName,
        name: lineName,
        phone_raw: phoneRaw,
        phone_normalized: phoneInfo.phone_normalized,
        phone_digits: phoneInfo.phone_digits,
        phone_status: phoneInfo.phone_status,
        phone_message: phoneInfo.phone_message,
        member_source: 'farmmember',
        join_method: 'farmmember',
        register_time: nowText_()
      }, {
        createIfPhoneInvalid: false
      });

      if (!res.ok) {
        return res;
      }

      member = res.member;
    }
  }

  return getFarmBootstrap(data);
}

function getFarmBootstrap(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  let memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    const created = registerLineMember_({
      line_user_id: lineUserId,
      line_name: clean_(data.line_name || 'LINE會員'),
      source: 'farmmember',
      note: 'Farmmember 自動建立'
    });

    if (!created.ok) {
      return created;
    }

    memberHit = findMemberByLineUserId_(lineUserId);
  }

  if (memberHit.ok && !clean_(memberHit.member.member_id) && clean_(memberHit.member.phone_normalized)) {
    const phoneRaw = clean_(memberHit.member.phone_raw || memberHit.member.phone_normalized);
    const phoneInfo = normalizePhoneWithRule_(phoneRaw);

    const patch = buildUpsertPatch_(
      memberHit.member,
      {
        line_user_id: lineUserId,
        line_name: clean_(data.line_name || memberHit.member.line_name || memberHit.member.name || 'LINE會員'),
        member_source: getSetting_('linked_source', 'linked'),
        link_status: 'linked'
      },
      phoneRaw,
      phoneInfo,
      clean_(memberHit.member.name || memberHit.member.line_name || data.line_name || 'LINE會員'),
      lineUserId
    );

    setMemberObjectToRow_(memberHit.sheet, memberHit.rowIndex, patch);
    memberHit = findMemberByLineUserId_(lineUserId);
  }

  const member = memberHit.member;

  let farm = getOrCreateFarmState(lineUserId, member.member_id);

  farm = applyDailyTick(farm);

  saveFarmState(lineUserId, member.member_id, farm);

  const hasPhone = !!clean_(member.phone_normalized);

  return {
    ok: true,
    need_phone: !hasPhone,
    member: buildFarmMemberView(member),
    farm: farm,
    crops: getFarmCrops(),
    inventory: farm.seedInventory || {},
    offers: getMemberOffers(member),
    redeemRule: {
      need: FARM_REWARD_NEED,
      text: '同一種作物收成 ' + FARM_REWARD_NEED + ' 次，可獲得 1 張對應兌換券'
    }
  };
}

function farmPlant(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const cropKey = clean_(data.crop || 'cabbage');
  const index = Number(data.index);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  if (isNaN(index) || index < 0 || index > FARM_PLOT_COUNT - 1) {
    return {
      ok: false,
      message: '農地位置錯誤'
    };
  }

  const memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    return {
      ok: false,
      message: '找不到會員'
    };
  }

  const member = memberHit.member;
  const crop = getFarmCrops()[cropKey];

  if (!crop) {
    return {
      ok: false,
      message: '作物不存在'
    };
  }

  const farm = getOrCreateFarmState(lineUserId, member.member_id);
  const lv = numberOrZero_(farm.level) || 1;

  if (lv < crop.unlockLevel) {
    return {
      ok: false,
      message: '等級不足，需要 Lv.' + crop.unlockLevel
    };
  }

  const plot = farm.plots[index];

  if (plot && plot.crop) {
    return {
      ok: false,
      message: '這格已經有作物'
    };
  }

  if (!farm.seedInventory) {
    farm.seedInventory = {};
  }

  const seedCount = numberOrZero_(farm.seedInventory[cropKey]);

  if (seedCount <= 0) {
    return {
      ok: false,
      message: crop.name + ' 庫存不足，請到商店購買'
    };
  }

  farm.seedInventory[cropKey] = seedCount - 1;

  farm.plots[index] = {
    crop: cropKey,
    stage: 0,
    progress: 0,
    plantedAt: todayText(),
    lastWaterDate: '',
    noWaterDays: 0,
    dead: false,
    ready: false
  };

  saveFarmState(lineUserId, member.member_id, farm);

  logFarm(
    lineUserId,
    member.member_id,
    'plant',
    cropKey,
    index,
    0,
    numberOrZero_(member.point),
    '種植成功'
  );

  return {
    ok: true,
    message: '種植成功',
    farm: farm,
    inventory: farm.seedInventory
  };
}

function farmWater(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  const memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    return {
      ok: false,
      message: '找不到會員'
    };
  }

  const today = todayText();
  const farm = getOrCreateFarmState(lineUserId, memberHit.member.member_id);

  const rainMm = numberOrZero_(farm.weather && farm.weather.rainMm);

  if (rainMm >= 25) {
    return {
      ok: false,
      message: '今天雨量足夠，系統已視為自動澆水，不需要手動澆水',
      farm: farm
    };
  }

  if (farm.lastWaterDate === today) {
    return {
      ok: false,
      message: '今天已經澆水過了'
    };
  }

  farm.lastWaterDate = today;

  farm.plots.forEach(function(plot) {
    if (!plot || !plot.crop || plot.dead || plot.ready) return;

    plot.lastWaterDate = today;
    plot.noWaterDays = 0;
  });

  saveFarmState(lineUserId, memberHit.member.member_id, farm);

  logFarm(
    lineUserId,
    memberHit.member.member_id,
    'water',
    '',
    '',
    0,
    memberHit.member.point,
    '今日澆水成功'
  );

  return {
    ok: true,
    message: '今日澆水成功，作物會在每日結算時加速成長',
    farm: farm
  };
}

function farmHarvest(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const index = Number(data.index);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  if (isNaN(index) || index < 0 || index > FARM_PLOT_COUNT - 1) {
    return {
      ok: false,
      message: '農地位置錯誤'
    };
  }

  const memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    return {
      ok: false,
      message: '找不到會員'
    };
  }

  const member = memberHit.member;
  const farm = getOrCreateFarmState(lineUserId, member.member_id);
  const plot = farm.plots[index];

  if (!plot || !plot.crop) {
    return {
      ok: false,
      message: '這格沒有作物'
    };
  }

  if (plot.dead) {
    farm.plots[index] = emptyFarmPlot();
    saveFarmState(lineUserId, member.member_id, farm);

    return {
      ok: true,
      message: '已清除枯萎作物',
      farm: farm
    };
  }

  if (!plot.ready && numberOrZero_(plot.progress) < 100) {
    return {
      ok: false,
      message: '作物尚未成熟'
    };
  }

  const cropKey = plot.crop;
  const crop = getFarmCrops()[cropKey];

  if (!farm.harvestCount) {
    farm.harvestCount = {};
  }

  if (!farm.coupons) {
    farm.coupons = {};
  }

  farm.harvestCount[cropKey] = numberOrZero_(farm.harvestCount[cropKey]) + 1;

  let couponCreated = false;

  if (farm.harvestCount[cropKey] >= FARM_REWARD_NEED) {
    farm.harvestCount[cropKey] -= FARM_REWARD_NEED;
    farm.coupons[cropKey] = numberOrZero_(farm.coupons[cropKey]) + 1;
    couponCreated = true;
  }

  farm.xp = numberOrZero_(farm.xp) + 20;
  farm.level = calcFarmLevel(farm.xp);
  farm.plots[index] = emptyFarmPlot();

  saveFarmState(lineUserId, member.member_id, farm);

  logFarm(
    lineUserId,
    member.member_id,
    'harvest',
    cropKey,
    index,
    0,
    member.point,
    couponCreated ? crop.name + '兌換券 +1' : crop.name + '收成 +1'
  );

  return {
    ok: true,
    message: couponCreated ? crop.name + '兌換券 +1' : crop.name + '收成成功',
    crop: cropKey,
    couponCreated: couponCreated,
    farm: farm
  };
}

function farmRedeemCoupon(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const cropKey = clean_(data.crop);

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  if (!cropKey) {
    return {
      ok: false,
      message: '缺少 crop'
    };
  }

  const memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    return {
      ok: false,
      message: '找不到會員'
    };
  }

  const member = memberHit.member;

  if (!canRedeemFarmCoupon(member)) {
    return {
      ok: false,
      needBind: true,
      message: '兌換需要完成會員資料，請先填寫姓名與電話'
    };
  }

  const farm = getOrCreateFarmState(lineUserId, member.member_id);

  if (numberOrZero_(farm.coupons[cropKey]) <= 0) {
    return {
      ok: false,
      message: '沒有可使用的兌換券'
    };
  }

  farm.coupons[cropKey] -= 1;

  saveFarmState(lineUserId, member.member_id, farm);

  logFarm(
    lineUserId,
    member.member_id,
    'redeem_coupon',
    cropKey,
    '',
    0,
    member.point,
    '使用兌換券'
  );

  return {
    ok: true,
    message: '兌換成功',
    farm: farm
  };
}

function canRedeemFarmCoupon(member) {
  return !!clean_(member.name) &&
         !!clean_(member.phone_normalized) &&
         clean_(member.phone_status) === 'valid';
}

function ensureFarmSheets() {
  const ss = openSS_();

  ensureSheet_(ss, SHEET_FARM_DATA, FARM_HEADERS);
  ensureSheet_(ss, SHEET_FARM_LOG, FARM_LOG_HEADERS);
}

function getOrCreateFarmState(lineUserId, memberId) {
  const sh = getOrCreateSheet_(openSS_(), SHEET_FARM_DATA);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (clean_(values[i][0]) === lineUserId) {
      const farmJson = clean_(values[i][4]);

      try {
        return normalizeFarmState(JSON.parse(farmJson || '{}'));
      } catch (err) {
        return defaultFarmState();
      }
    }
  }

  const farm = defaultFarmState();

  sh.appendRow([
    lineUserId,
    memberId,
    0,
    JSON.stringify(farm.plots),
    JSON.stringify(farm),
    todayText(),
    '',
    nowText_()
  ]);

  return farm;
}

function saveFarmState(lineUserId, memberId, farm) {
  const sh = getOrCreateSheet_(openSS_(), SHEET_FARM_DATA);
  const values = sh.getDataRange().getValues();
  const safeFarm = normalizeFarmState(farm);

  for (let i = 1; i < values.length; i++) {
    if (clean_(values[i][0]) === lineUserId) {
      sh.getRange(i + 1, 2).setValue(memberId);
      sh.getRange(i + 1, 4).setValue(JSON.stringify(safeFarm.plots));
      sh.getRange(i + 1, 5).setValue(JSON.stringify(safeFarm));
      sh.getRange(i + 1, 6).setValue(todayText());
      sh.getRange(i + 1, 7).setValue(safeFarm.lastWaterDate || '');
      sh.getRange(i + 1, 8).setValue(nowText_());
      return;
    }
  }

  sh.appendRow([
    lineUserId,
    memberId,
    0,
    JSON.stringify(safeFarm.plots),
    JSON.stringify(safeFarm),
    todayText(),
    safeFarm.lastWaterDate || '',
    nowText_()
  ]);
}

function defaultFarmState() {
  return {
    level: 1,
    xp: 0,
    lastWaterDate: '',
    last_calc_date: '',
    weather: {
      rainMm: 0,
      tempC: 25,
      text: '無雨'
    },
    seedInventory: {
      cabbage: 0,
      carrot: 0,
      corn: 0,
      watermelon: 0,
      strawberry: 0
    },
    plots: new Array(FARM_PLOT_COUNT).fill(null).map(function() {
      return emptyFarmPlot();
    }),
    harvestCount: {
      cabbage: 0,
      carrot: 0,
      corn: 0,
      watermelon: 0,
      strawberry: 0
    },
    coupons: {
      cabbage: 0,
      carrot: 0,
      corn: 0,
      watermelon: 0,
      strawberry: 0
    }
  };
}

function normalizeFarmState(farm) {
  const base = defaultFarmState();

  farm = farm || {};

  base.level = numberOrZero_(farm.level) || 1;
  base.xp = numberOrZero_(farm.xp);
  base.lastWaterDate = clean_(farm.lastWaterDate);
  base.last_calc_date = clean_(farm.last_calc_date || farm.lastCalcDate);

  if (farm.weather) {
    base.weather = farm.weather;
  }

  if (Array.isArray(farm.plots)) {
    for (let i = 0; i < FARM_PLOT_COUNT; i++) {
      base.plots[i] = farm.plots[i] || emptyFarmPlot();
    }
  }

  ['cabbage', 'carrot', 'corn', 'watermelon', 'strawberry'].forEach(function(key) {
    if (farm.harvestCount) {
      base.harvestCount[key] = numberOrZero_(farm.harvestCount[key]);
    }

    if (farm.coupons) {
      base.coupons[key] = numberOrZero_(farm.coupons[key]);
    }

    if (farm.seedInventory) {
      base.seedInventory[key] = numberOrZero_(farm.seedInventory[key]);
    }
  });

  return base;
}

function emptyFarmPlot() {
  return {
    crop: '',
    stage: -1,
    progress: 0,
    plantedAt: '',
    lastWaterDate: '',
    noWaterDays: 0,
    dead: false,
    ready: false
  };
}

function getFarmCrops() {
  return {
    cabbage: {
      key: 'cabbage',
      name: '高麗菜',
      cost: 5,
      unlockLevel: 1,
      growDays: 20,
      couponName: '高麗菜兌換券'
    },
    carrot: {
      key: 'carrot',
      name: '胡蘿蔔',
      cost: 8,
      unlockLevel: 2,
      growDays: 20,
      couponName: '胡蘿蔔兌換券'
    },
    corn: {
      key: 'corn',
      name: '玉米',
      cost: 10,
      unlockLevel: 3,
      growDays: 20,
      couponName: '玉米兌換券'
    },
    watermelon: {
      key: 'watermelon',
      name: '西瓜',
      cost: 12,
      unlockLevel: 5,
      growDays: 20,
      couponName: '西瓜兌換券'
    },
    strawberry: {
      key: 'strawberry',
      name: '草莓',
      cost: 16,
      unlockLevel: 7,
      growDays: 20,
      couponName: '草莓兌換券'
    }
  };
}

function calcStageByProgress(progress) {
  progress = numberOrZero_(progress);

  if (progress >= 100) return 4;
  if (progress >= 75) return 3;
  if (progress >= 50) return 2;
  if (progress >= 25) return 1;

  return 0;
}

function calcFarmLevel(xp) {
  xp = numberOrZero_(xp);

  let level = 1;

  while (xp >= level * 100) {
    xp -= level * 100;
    level++;
  }

  return level;
}

function buildFarmMemberView(member) {
  return {
    member_id: clean_(member.member_id),
    name: clean_(member.name || member.line_name || 'LINE會員'),
    phone: clean_(member.phone_normalized),
    line_user_id: clean_(member.line_user_id),
    line_name: clean_(member.line_name),
    line_picture: clean_(member.line_picture || member.pictureUrl || ''),
    balance: numberOrZero_(member.wallet_balance || member.balance),
    bonus: numberOrZero_(member.bonus_balance || member.bonus),
    point: numberOrZero_(member.point),
    level: clean_(member.level || 'normal'),
    status: clean_(member.status),
    referral_code: clean_(member.my_referral_code),
    new_member_coupon_sent: clean_(member.new_member_coupon_sent),
    social_campaign: clean_(member.social_campaign),
    social_coupon_sent: clean_(member.social_coupon_sent),
    referral_reward_sent: clean_(member.referral_reward_sent)
  };
}

function getMemberOffers(member) {
  return {
    newMemberCouponSent: clean_(member.new_member_coupon_sent),
    socialCouponSent: clean_(member.social_coupon_sent),
    referralRewardSent: clean_(member.referral_reward_sent),
    referralCode: clean_(member.my_referral_code)
  };
}

function logFarm(lineUserId, memberId, action, crop, plotIndex, cost, pointAfter, message) {
  getOrCreateSheet_(openSS_(), SHEET_FARM_LOG).appendRow([
    nowText_(),
    lineUserId || '',
    memberId || '',
    action || '',
    crop || '',
    plotIndex === '' ? '' : plotIndex,
    cost || 0,
    pointAfter || 0,
    message || ''
  ]);
}

/**
 * 商店購買種子
 * 扣遊戲點，增加 seedInventory
 */
function farmShopBuy(data) {
  initSystem_();
  ensureFarmSheets();

  const lineUserId = clean_(data.line_user_id || data.userId);
  const cropKey = clean_(data.crop);
  const qty = Math.max(1, Number(data.qty || 1));

  if (!lineUserId) {
    return {
      ok: false,
      message: '缺少 line_user_id'
    };
  }

  if (!cropKey) {
    return {
      ok: false,
      message: '缺少 crop'
    };
  }

  const memberHit = findMemberByLineUserId_(lineUserId);

  if (!memberHit.ok) {
    return {
      ok: false,
      message: '找不到會員'
    };
  }

  const member = memberHit.member;
  const crop = getFarmCrops()[cropKey];

  if (!crop) {
    return {
      ok: false,
      message: '作物不存在'
    };
  }

  const farm = getOrCreateFarmState(lineUserId, member.member_id);
  const lv = numberOrZero_(farm.level) || 1;

  if (lv < (crop.unlockLevel || 1)) {
    return {
      ok: false,
      message: '等級不足，需要 Lv.' + crop.unlockLevel
    };
  }

  const cost = crop.cost * qty;
  const point = numberOrZero_(member.point);

  if (point < cost) {
    return {
      ok: false,
      message: '遊戲點數不足，需要 ' + cost + ' 點'
    };
  }

  adjustPoint_({
    line_user_id: lineUserId,
    change: -cost,
    type: 'farm_seed_buy',
    operator: 'farmmember',
    note: '購買種子 ' + crop.name + ' × ' + qty
  });

  if (!farm.seedInventory) {
    farm.seedInventory = {};
  }

  farm.seedInventory[cropKey] = numberOrZero_(farm.seedInventory[cropKey]) + qty;

  saveFarmState(lineUserId, member.member_id, farm);

  const refreshed = findMemberByLineUserId_(lineUserId);
  const finalMember = refreshed.ok ? refreshed.member : member;

  logFarm(
    lineUserId,
    member.member_id,
    'shop_buy',
    cropKey,
    '',
    cost,
    point - cost,
    '購買 ' + crop.name + ' × ' + qty
  );

  return {
    ok: true,
    message: '已購買 ' + crop.name + ' × ' + qty,
    inventory: farm.seedInventory,
    point_after: point - cost,
    member: buildFarmMemberView(finalMember)
  };
}

function todayText() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function dateDiffDays(from, to) {
  try {
    const a = new Date(from + 'T00:00:00+08:00');
    const b = new Date(to + 'T00:00:00+08:00');

    return Math.round((b - a) / 86400000);
  } catch (err) {
    return 0;
  }
}

function addDaysText(dateText, add) {
  const d = new Date(dateText + 'T00:00:00+08:00');

  d.setDate(d.getDate() + add);

  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function isRainyEnough(farm) {
  const weather = farm.weather || {};
  const rainMm = numberOrZero_(weather.rainMm);

  return rainMm > 0;
}

function getWiltLimitByWeather(farm) {
  const weather = farm.weather || {};
  const tempC = numberOrZero_(weather.tempC || 25);

  return tempC > 30 ? 3 : 5;
}

/**
 * 每日成長 tick
 *
 * 規則：
 * 1. 一般每天 +5 分
 * 2. 有澆水或下雨，該日 +7.5 分
 * 3. 100 分可收成
 * 4. 高溫超過 30 度，連續 3 天沒澆水或下雨會枯萎
 * 5. 一般天氣，連續 5 天沒澆水或下雨會枯萎
 */
function applyDailyTick(farm) {
  const today = todayText();
  const lastCalc = clean_(farm.last_calc_date || farm.lastCalcDate || today);
  const days = dateDiffDays(lastCalc, today);

  if (days <= 0) {
    return farm;
  }

  const rainy = isRainyEnough(farm);
  const wiltLimit = getWiltLimitByWeather(farm);

  farm.plots.forEach(function(plot) {
    if (!plot || !plot.crop || plot.dead || plot.ready) return;

    for (let i = 1; i <= days; i++) {
      const calcDate = addDaysText(lastCalc, i);
      const watered = clean_(plot.lastWaterDate) === calcDate || rainy;

      if (watered) {
        plot.noWaterDays = 0;
        plot.progress = Math.min(100, numberOrZero_(plot.progress) + FARM_WATER_GROW_POINT);
      } else {
        plot.noWaterDays = numberOrZero_(plot.noWaterDays) + 1;
        plot.progress = Math.min(100, numberOrZero_(plot.progress) + FARM_BASE_GROW_POINT);
      }

      if (plot.noWaterDays >= wiltLimit) {
        plot.dead = true;
        plot.stage = 5;
        break;
      }

      plot.stage = calcStageByProgress(plot.progress);

      if (plot.progress >= 100) {
        plot.ready = true;
        plot.stage = 4;
        break;
      }
    }
  });

  farm.last_calc_date = today;

  return farm;
}