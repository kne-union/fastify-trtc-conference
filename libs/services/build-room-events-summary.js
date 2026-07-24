const dayjs = require('dayjs');

const MAX_CHART_POINTS = 300;
const MAX_TIMELINE_PER_MEMBER = 200;
const SCAN_BATCH_SIZE = 1000;

const CHART_EVENT_CODES = new Set(['Client.network-quality', 'Client.statistics', 'DescribeCallDetailInfo.Metric']);
const DEVICE_INFO_CODE = 'Client.device-info';

const getPayload = event => event.payload || {};

const getEventData = event => {
  const payload = getPayload(event);
  return payload.event?.data || payload.data || {};
};

const getEventReporterId = event => {
  const payload = getPayload(event);
  return String(payload.reporterId || payload.event?.reporterId || payload.userId || payload.peerId || payload.event?.UserId || '-');
};

const getEventActorId = event => {
  const payload = getPayload(event);
  return String(payload.event?.userId || payload.event?.data?.userId || payload.peerId || payload.event?.UserId || payload.userId || '-');
};

const getNestedValue = (target, path) => {
  if (!target || !path) {
    return undefined;
  }
  const parts = String(path).split('.');
  let current = target;
  for (const part of parts) {
    if (current == null) {
      return undefined;
    }
    current = current[part];
  }
  return current;
};

const getMetricValue = (target, paths) => {
  for (const path of paths) {
    const value = getNestedValue(target, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
};

const toNumber = value => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
};

const formatIntegerMetric = value => {
  const numberValue = toNumber(value);
  return numberValue === undefined ? undefined : Math.round(numberValue);
};

const formatAudioLevelMetric = value => {
  const numberValue = toNumber(value);
  return numberValue === undefined ? undefined : Number((numberValue * 100).toFixed(2));
};

const isEnterEvent = event => {
  const payload = getPayload(event);
  return (
    event.code === 'Client.enter' ||
    event.code === 'enter' ||
    event.code === '1001' ||
    payload.paramOne === 'enter' ||
    payload.event?.ParamOne === 'enter'
  );
};

const isExitEvent = event => {
  const payload = getPayload(event);
  return (
    event.code === 'Client.exit' ||
    event.code === 'exit' ||
    event.code === '1002' ||
    payload.paramOne === 'exit' ||
    payload.event?.ParamOne === 'exit'
  );
};

const isDismissEvent = event => {
  const payload = getPayload(event);
  return event.code === '103' || payload.eventType === 103 || payload.event?.EventId === 103;
};

const isTimelineEvent = event => !CHART_EVENT_CODES.has(event.code) && event.code !== DEVICE_INFO_CODE;

const ensureMemberState = (memberStates, userId) => {
  if (!memberStates.has(userId)) {
    memberStates.set(userId, {
      userId,
      online: false,
      cameraOpen: null,
      microphoneOpen: null,
      worstNetwork: 0,
      deviceInfo: null,
      timeline: [],
      networkQualitySamples: [],
      statisticsSamples: [],
      callMetricSamples: [],
      statsAgg: {
        rttSum: 0,
        rttCount: 0,
        maxRtt: -Infinity,
        lossSum: 0,
        lossCount: 0,
        frameRateSum: 0,
        frameRateCount: 0,
        audioLevelSum: 0,
        audioLevelCount: 0
      }
    });
  }
  return memberStates.get(userId);
};

const slimDeviceInfo = (event, data) => {
  const audioDevices = data.audioDevices || [];
  const videoDevices = data.videoDevices || [];
  const selectedAudio = audioDevices.find(device => device.deviceId === data.audioDeviceId);
  const selectedVideo = videoDevices.find(device => device.deviceId === data.videoDeviceId);
  return {
    time: event.time,
    userAgent: data.userAgent || null,
    platform: data.platform || null,
    language: data.language || null,
    screenWidth: data.screenWidth || null,
    screenHeight: data.screenHeight || null,
    devicePixelRatio: data.devicePixelRatio || null,
    connection: data.connection || null,
    selectedAudioLabel: selectedAudio?.label || selectedAudio?.deviceId || null,
    selectedVideoLabel: selectedVideo?.label || selectedVideo?.deviceId || null,
    audioDeviceLabels: audioDevices.map(device => device.label || device.deviceId).filter(Boolean),
    videoDeviceLabels: videoDevices.map(device => device.label || device.deviceId).filter(Boolean)
  };
};

const updateStatsAgg = (agg, data) => {
  const rtt = toNumber(getMetricValue(data, ['rtt']));
  if (rtt !== undefined) {
    agg.rttSum += rtt;
    agg.rttCount += 1;
    if (rtt > agg.maxRtt) {
      agg.maxRtt = rtt;
    }
  }
  const upLoss = toNumber(getMetricValue(data, ['upLoss']));
  const downLoss = toNumber(getMetricValue(data, ['downLoss']));
  if (upLoss !== undefined || downLoss !== undefined) {
    agg.lossSum += ((upLoss || 0) + (downLoss || 0)) / 2;
    agg.lossCount += 1;
  }
  const frameRate = toNumber(getMetricValue(data, ['localStatistics.video.0.frameRate']));
  if (frameRate !== undefined) {
    agg.frameRateSum += frameRate;
    agg.frameRateCount += 1;
  }
  const audioLevel = toNumber(getMetricValue(data, ['localStatistics.audio.audioLevel']));
  if (audioLevel !== undefined) {
    agg.audioLevelSum += audioLevel;
    agg.audioLevelCount += 1;
  }
};

const buildAnalysis = statsAgg => {
  if (
    statsAgg.rttCount === 0 &&
    statsAgg.lossCount === 0 &&
    statsAgg.frameRateCount === 0 &&
    statsAgg.audioLevelCount === 0
  ) {
    return null;
  }
  const avgRtt = statsAgg.rttCount > 0 ? statsAgg.rttSum / statsAgg.rttCount : undefined;
  const maxRtt = statsAgg.maxRtt === -Infinity ? undefined : statsAgg.maxRtt;
  const avgLoss = statsAgg.lossCount > 0 ? statsAgg.lossSum / statsAgg.lossCount : undefined;
  const avgFrameRate = statsAgg.frameRateCount > 0 ? statsAgg.frameRateSum / statsAgg.frameRateCount : undefined;
  const avgAudioLevel = statsAgg.audioLevelCount > 0 ? statsAgg.audioLevelSum / statsAgg.audioLevelCount : undefined;

  const issueCodes = [];
  let type = 'success';
  if ((avgRtt !== undefined && avgRtt > 150) || (maxRtt !== undefined && maxRtt > 300) || (avgLoss !== undefined && avgLoss > 5)) {
    type = 'error';
    issueCodes.push('NetworkBadAnalysis');
  } else if ((avgRtt !== undefined && avgRtt > 100) || (avgLoss !== undefined && avgLoss > 0)) {
    type = 'warning';
    issueCodes.push('NetworkWarningAnalysis');
  }
  if (avgFrameRate !== undefined && avgFrameRate < 15) {
    type = 'error';
    issueCodes.push('FrameRateBadAnalysis');
  } else if (avgFrameRate !== undefined && avgFrameRate < 20 && type !== 'error') {
    type = 'warning';
    issueCodes.push('FrameRateWarningAnalysis');
  }
  if (avgAudioLevel !== undefined && avgAudioLevel < 0.01) {
    if (type !== 'error') {
      type = 'warning';
    }
    issueCodes.push('AudioLevelLowAnalysis');
  } else if (avgAudioLevel !== undefined && avgAudioLevel > 0.2) {
    if (type !== 'error') {
      type = 'warning';
    }
    issueCodes.push('AudioLevelHighAnalysis');
  }

  const metrics = [
    avgRtt !== undefined ? { key: 'rtt', value: `${Math.round(avgRtt)}ms` } : null,
    avgLoss !== undefined ? { key: 'packetLoss', value: `${Math.round(avgLoss)}%` } : null,
    avgFrameRate !== undefined ? { key: 'frameRate', value: `${Math.round(avgFrameRate)}fps` } : null,
    avgAudioLevel !== undefined ? { key: 'audioLevel', value: `${(avgAudioLevel * 100).toFixed(2)}%` } : null
  ].filter(Boolean);

  return {
    type,
    issueCodes: issueCodes.length > 0 ? issueCodes : ['QualityNormalAnalysis'],
    metrics
  };
};

const formatTimeLabel = timeValue => dayjs(timeValue).format('HH:mm:ss');

const downsampleSeries = (samples, metricKeys, { maxPoints = MAX_CHART_POINTS, reduce = 'last' } = {}) => {
  if (!samples.length) {
    return null;
  }
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  const start = sorted[0].t;
  const end = sorted[sorted.length - 1].t;
  const span = Math.max(end - start, 1);
  const bucketCount = Math.min(maxPoints, sorted.length);
  const bucketSize = span / bucketCount;
  const buckets = Array.from({ length: bucketCount }, () => null);

  sorted.forEach(sample => {
    let index = Math.floor((sample.t - start) / bucketSize);
    if (index >= bucketCount) {
      index = bucketCount - 1;
    }
    if (!buckets[index]) {
      buckets[index] = {
        t: sample.t,
        count: 0,
        values: Object.fromEntries(metricKeys.map(key => [key, 0]))
      };
    }
    const bucket = buckets[index];
    bucket.t = sample.t;
    bucket.count += 1;
    metricKeys.forEach(key => {
      const value = toNumber(sample[key]);
      if (value === undefined) {
        return;
      }
      if (reduce === 'avg') {
        bucket.values[key] += value;
      } else {
        bucket.values[key] = value;
      }
    });
  });

  const filled = buckets.filter(Boolean);
  if (filled.length === 0) {
    return null;
  }

  return {
    labels: filled.map(bucket => formatTimeLabel(bucket.t)),
    series: metricKeys.map(key => ({
      key,
      data: filled.map(bucket => {
        if (!bucket.count) {
          return null;
        }
        if (reduce === 'avg') {
          return Number((bucket.values[key] / bucket.count).toFixed(2));
        }
        return bucket.values[key];
      })
    }))
  };
};

const downsampleCallMetric = (samples, { maxPoints = MAX_CHART_POINTS } = {}) => {
  if (!samples.length) {
    return null;
  }
  const names = Array.from(new Set(samples.map(item => item.name).filter(Boolean)));
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  const start = sorted[0].t;
  const end = sorted[sorted.length - 1].t;
  const span = Math.max(end - start, 1);
  const bucketCount = Math.min(maxPoints, Math.max(sorted.length, 1));
  const bucketSize = span / bucketCount;
  const labels = [];
  const seriesMap = Object.fromEntries(names.map(name => [name, []]));

  for (let i = 0; i < bucketCount; i += 1) {
    const bucketStart = start + i * bucketSize;
    const bucketEnd = i === bucketCount - 1 ? end + 1 : start + (i + 1) * bucketSize;
    const inBucket = sorted.filter(item => item.t >= bucketStart && item.t < bucketEnd);
    if (inBucket.length === 0) {
      continue;
    }
    labels.push(formatTimeLabel(inBucket[inBucket.length - 1].t));
    names.forEach(name => {
      const points = inBucket.filter(item => item.name === name);
      if (points.length === 0) {
        seriesMap[name].push(null);
        return;
      }
      seriesMap[name].push(points[points.length - 1].value);
    });
  }

  if (labels.length === 0) {
    return null;
  }

  return {
    labels,
    series: names.map(name => ({
      key: name,
      data: seriesMap[name]
    }))
  };
};

const processEvent = (event, context) => {
  const timeValue = dayjs(event.time).valueOf();
  if (!Number.isFinite(timeValue)) {
    return;
  }
  context.lastEventTime = timeValue;

  if (isEnterEvent(event)) {
    context.enterTimes.push(timeValue);
    context.onlineCount += 1;
  }
  if (isExitEvent(event)) {
    context.onlineCount = Math.max(0, context.onlineCount - 1);
    if (context.onlineCount === 0) {
      context.roomEmptyAt = timeValue;
    }
  }
  if (isDismissEvent(event)) {
    context.dismissAt = timeValue;
  }

  const reporterId = getEventReporterId(event);
  if (!reporterId || reporterId === '-') {
    return;
  }
  context.eventUserIds.add(reporterId);
  const member = ensureMemberState(context.memberStates, reporterId);

  if (event.code === 'Client.enter' || event.code === 'enter') {
    member.online = true;
  }
  if (event.code === 'Client.exit' || event.code === 'exit') {
    member.online = false;
  }
  if (event.code === 'Client.camera-open') {
    member.cameraOpen = true;
  }
  if (event.code === 'Client.camera-close') {
    member.cameraOpen = false;
  }
  if (event.code === 'Client.microphone-open') {
    member.microphoneOpen = true;
  }
  if (event.code === 'Client.microphone-close') {
    member.microphoneOpen = false;
  }

  if (event.code === DEVICE_INFO_CODE) {
    member.deviceInfo = slimDeviceInfo(event, getEventData(event));
  }

  if (isTimelineEvent(event) && member.timeline.length < MAX_TIMELINE_PER_MEMBER) {
    member.timeline.push({
      time: event.time,
      code: event.code,
      actorUserId: getEventActorId(event)
    });
  }

  if (event.code === 'Client.network-quality') {
    const data = getEventData(event);
    const uplink = formatIntegerMetric(data.uplinkNetworkQuality);
    const downlink = formatIntegerMetric(data.downlinkNetworkQuality);
    const quality = Math.max(Number(data.uplinkNetworkQuality) || 0, Number(data.downlinkNetworkQuality) || 0);
    if (quality > member.worstNetwork) {
      member.worstNetwork = quality;
    }
    member.networkQualitySamples.push({
      t: timeValue,
      uplinkNetworkQuality: uplink,
      downlinkNetworkQuality: downlink
    });
  }

  if (event.code === 'Client.statistics') {
    const data = getEventData(event);
    updateStatsAgg(member.statsAgg, data);
    member.statisticsSamples.push({
      t: timeValue,
      rtt: formatIntegerMetric(getMetricValue(data, ['rtt'])),
      upLoss: formatIntegerMetric(getMetricValue(data, ['upLoss'])),
      downLoss: formatIntegerMetric(getMetricValue(data, ['downLoss'])),
      audioBitrate: formatIntegerMetric(getMetricValue(data, ['localStatistics.audio.bitrate'])),
      audioLevel: formatAudioLevelMetric(getMetricValue(data, ['localStatistics.audio.audioLevel'])),
      videoBitrate: formatIntegerMetric(getMetricValue(data, ['localStatistics.video.0.bitrate'])),
      frameRate: formatIntegerMetric(getMetricValue(data, ['localStatistics.video.0.frameRate']))
    });
  }

  if (event.code === 'DescribeCallDetailInfo.Metric') {
    const payload = getPayload(event);
    const data = payload.data || {};
    (data.Content || []).forEach(item => {
      member.callMetricSamples.push({
        t: Number(item.Time) * 1000,
        name: data.DataType || payload.dataType,
        value: formatIntegerMetric(item.Value)
      });
    });
  }
};

const buildOverview = (context, { status, now = Date.now() } = {}) => {
  const actualStart = context.enterTimes.length > 0 ? Math.min(...context.enterTimes) : null;
  let actualEnd = null;
  let useLiveEnd = false;
  if (context.roomEmptyAt != null || context.dismissAt != null) {
    actualEnd = Math.max(context.roomEmptyAt || 0, context.dismissAt || 0) || null;
  } else if (status === 1 && context.lastEventTime != null) {
    actualEnd = context.lastEventTime;
  } else if (status !== 1 && actualStart != null) {
    actualEnd = now;
    useLiveEnd = true;
  }
  const actualDurationSeconds =
    actualStart != null && actualEnd != null && actualEnd >= actualStart ? Math.round((actualEnd - actualStart) / 1000) : null;
  return {
    actualStart: actualStart != null ? new Date(actualStart).toISOString() : null,
    actualEnd: actualEnd != null ? new Date(actualEnd).toISOString() : null,
    actualDurationSeconds,
    useLiveEnd
  };
};

const finalizeMember = member => {
  const analysis = buildAnalysis(member.statsAgg);
  return {
    userId: member.userId,
    deviceInfo: member.deviceInfo,
    analysis,
    charts: {
      networkQuality: downsampleSeries(member.networkQualitySamples, ['uplinkNetworkQuality', 'downlinkNetworkQuality'], {
        reduce: 'last'
      }),
      statisticsNetwork: downsampleSeries(member.statisticsSamples, ['rtt', 'upLoss', 'downLoss'], { reduce: 'avg' }),
      statisticsMedia: downsampleSeries(member.statisticsSamples, ['audioBitrate', 'audioLevel', 'videoBitrate', 'frameRate'], {
        reduce: 'avg'
      }),
      callMetric: downsampleCallMetric(member.callMetricSamples)
    },
    timeline: member.timeline,
    _state: {
      online: member.online,
      cameraOpen: member.cameraOpen,
      microphoneOpen: member.microphoneOpen,
      worstNetwork: member.worstNetwork,
      hasErrorAnalysis: analysis?.type === 'error'
    }
  };
};

const buildSummaryCounts = (members, conferenceMembers = []) => {
  const memberIds = conferenceMembers.map(member => String(member.id)).filter(Boolean);
  const eventUserIds = members.map(member => String(member.userId));
  const userIds = Array.from(new Set(memberIds.concat(eventUserIds)));
  const memberMap = new Map(members.map(member => [String(member.userId), member]));

  let onlineCount = 0;
  let networkIssueCount = 0;
  let deviceIssueCount = 0;
  userIds.forEach(userId => {
    const member = memberMap.get(String(userId));
    if (!member) {
      return;
    }
    if (member._state.online) {
      onlineCount += 1;
    }
    if (member._state.worstNetwork >= 4 || member._state.hasErrorAnalysis) {
      networkIssueCount += 1;
    }
    if (member._state.cameraOpen === false || member._state.microphoneOpen === false) {
      deviceIssueCount += 1;
    }
  });

  return {
    memberCount: conferenceMembers.length || userIds.length,
    onlineCount,
    networkIssueCount,
    deviceIssueCount
  };
};

const createSummaryContext = () => ({
  enterTimes: [],
  onlineCount: 0,
  roomEmptyAt: null,
  dismissAt: null,
  lastEventTime: null,
  eventUserIds: new Set(),
  memberStates: new Map(),
  processedCount: 0
});

const scanAndProcessInstanceEvents = async ({ instanceEventModel, instanceCaseId, context, batchSize = SCAN_BATCH_SIZE }) => {
  let offset = 0;
  while (true) {
    const rows = await instanceEventModel.findAll({
      where: { trtcInstanceCaseId: instanceCaseId },
      order: [['time', 'ASC']],
      offset,
      limit: batchSize
    });
    if (!rows || rows.length === 0) {
      break;
    }
    rows.forEach(row => {
      processEvent(row.toJSON ? row.toJSON() : row, context);
      context.processedCount += 1;
    });
    if (rows.length < batchSize) {
      break;
    }
    offset += batchSize;
  }
  return context.processedCount;
};

const finalizeSummaryContext = (context, { members = [], status, now } = {}) => {
  (members || []).forEach(member => {
    if (member?.id) {
      ensureMemberState(context.memberStates, String(member.id));
    }
  });
  const finalizedMembers = Array.from(context.memberStates.values()).map(finalizeMember);
  return {
    overview: buildOverview(context, { status, now }),
    summary: buildSummaryCounts(finalizedMembers, members),
    members: finalizedMembers.map(member => {
      const { _state, ...rest } = member;
      return rest;
    })
  };
};

const buildRoomEventsSummaryFromEvents = (events, { members = [], status, now } = {}) => {
  const context = createSummaryContext();
  (events || []).forEach(event => processEvent(event, context));
  return finalizeSummaryContext(context, { members, status, now });
};

const buildRoomEventsSummary = async ({
  conference,
  instanceCaseModel,
  instanceEventModel,
  syncRoomUserEvents,
  now
}) => {
  const empty = () =>
    buildRoomEventsSummaryFromEvents([], {
      members: conference.members || [],
      status: conference.status,
      now
    });

  if (!instanceCaseModel || !instanceEventModel) {
    return empty();
  }

  const instanceCase = await instanceCaseModel.findOne({ where: { roomId: conference.id } });
  if (!instanceCase) {
    return empty();
  }

  const context = createSummaryContext();
  let processedCount = await scanAndProcessInstanceEvents({
    instanceEventModel,
    instanceCaseId: instanceCase.id,
    context
  });

  if (processedCount === 0 && syncRoomUserEvents) {
    await syncRoomUserEvents({
      instanceCase,
      options: conference.options?.setting
    });
    await scanAndProcessInstanceEvents({
      instanceEventModel,
      instanceCaseId: instanceCase.id,
      context
    });
  }

  return finalizeSummaryContext(context, {
    members: conference.members || [],
    status: conference.status,
    now
  });
};

module.exports = {
  MAX_CHART_POINTS,
  MAX_TIMELINE_PER_MEMBER,
  SCAN_BATCH_SIZE,
  buildRoomEventsSummary,
  buildRoomEventsSummaryFromEvents,
  downsampleSeries,
  downsampleCallMetric
};
