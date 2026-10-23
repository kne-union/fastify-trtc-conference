// 响应 schema 会参与 fast-json-stringify 序列化：对象一律 additionalProperties: true 以免裁掉未声明字段；
// 用 nullable 而非类型数组（类型数组遇到不匹配的值会直接 500），类型不确定的字段（如 id、日期、JSON 列）只写说明不声明类型
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const bool = description => ({ type: 'boolean', nullable: true, description });
const any = description => ({ description });
const list = (description, items) => ({ type: 'array', nullable: true, description, items });
const obj = (description, properties = {}) => ({ type: 'object', nullable: true, description, additionalProperties: true, properties });

const success = (description, schema) => ({
  200: Object.assign({}, schema || { type: 'object' }, { description })
});

const empty = (description = '操作成功，返回空对象') => success(description);

const CONFERENCE_STATUS = '会议状态：0 正常，1 已结束，2 已取消';

const member = (description = '参会人') =>
  obj(description, {
    id: any('参会人 ID'),
    conferenceId: any('所属会议 ID'),
    email: str('邮箱'),
    nickname: str('昵称'),
    avatar: str('头像（文件 ID 或 URL）'),
    isMaster: bool('是否为主持人'),
    attended: bool('是否参加过会议'),
    shorten: str('参会人进入会议的邀请码'),
    createdAt: any('创建时间'),
    updatedAt: any('更新时间')
  });

const conferenceProperties = () => ({
  id: any('会议 ID，同时作为 TRTC 房间号'),
  name: str('会议名称'),
  startTime: any('会议开始时间'),
  duration: num('会议时长，单位：秒'),
  isInvitationAllowed: bool('是否允许参会人邀请他人'),
  origin: str('会议来源，如 system-created、co-interview'),
  maxCount: num('最大参会人数'),
  status: num(CONFERENCE_STATUS),
  options: any('会议附属信息：setting（录制 record、语音识别 speech 等 TRTC 设置）、document（会议文档）、documentVisibleAll、allowEarlyEnter、forceExitGrace、recordTaskId、aiTranscription、recordFiles 等'),
  userId: any('创建会议的用户 ID'),
  members: list('参会人列表', member()),
  createdAt: any('创建时间'),
  updatedAt: any('更新时间')
});

const conference = (description = '会议') => obj(description, conferenceProperties());

const conferenceDetail = (description = '会议详情') =>
  obj(
    description,
    Object.assign(conferenceProperties(), {
      recordings: list(
        '会议录像文件列表，未生成录像时不返回',
        obj('录像文件', {
          fileId: any('文件 ID'),
          filename: str('文件名'),
          url: str('文件访问地址')
        })
      ),
      transcription: any('AI 转写内容（content 客户端记录、rounds TRTC 转写轮次、text 合并文本），未开启语音识别或无内容时不返回')
    })
  );

const transcription = obj('AI 转写内容；未开启语音识别或没有内容时为空对象', {
  content: list('客户端上报的转写记录', any('转写记录')),
  rounds: list('TRTC AI 转写任务结果中的轮次', any('转写轮次')),
  text: str('合并后的转写文本，按行分隔')
});

const shorten = obj('邀请码', {
  shorten: str('邀请码，有效期一个月，用于 x-trtc-conference-code 请求头或 code 参数')
});

const inviter = any('邀请人：主持人邀请时为参会人记录，会议创建者邀请时为 { fromUser: true, nickname }');

const conferenceSummaryFields = () => ({
  conferenceId: any('会议 ID'),
  conferenceName: str('会议名称'),
  conferenceStatus: num(CONFERENCE_STATUS),
  startTime: any('会议开始时间'),
  duration: num('会议时长，单位：秒')
});

const instanceEventList = (description, extra = {}) =>
  obj(
    description,
    Object.assign(
      {
        pageData: list(
          '当前页 TRTC 房间事件',
          obj('TRTC 房间事件', {
            id: any('事件 ID'),
            code: str('事件编码，如 Client.enter、Client.exit'),
            time: any('事件发生时间'),
            payload: any('事件详情'),
            trtcInstanceCaseId: any('所属 TRTC 实例 ID'),
            createdAt: any('创建时间'),
            updatedAt: any('更新时间')
          })
        ),
        totalCount: num('事件总数')
      },
      extra
    )
  );

const roomEventsSummary = (description, extra = {}) =>
  obj(
    description,
    Object.assign(
      {
        overview: obj('房间整体情况', {
          actualStart: any('第一个人实际进入房间的时间（ISO 字符串），无则为 null'),
          actualEnd: any('房间实际结束时间（ISO 字符串），无则为 null'),
          actualDurationSeconds: any('实际持续秒数，无法计算时为 null'),
          useLiveEnd: bool('会议仍在进行，actualEnd 取当前时间')
        }),
        summary: obj('人数统计', {
          memberCount: num('参会人数'),
          onlineCount: num('当前在线人数'),
          networkIssueCount: num('网络有问题的人数'),
          deviceIssueCount: num('设备有问题的人数')
        }),
        members: list(
          '按成员聚合的事件分析，不含原始高频事件',
          obj('成员事件分析', {
            userId: any('TRTC 用户 ID（参会人 ID）'),
            deviceInfo: any('设备信息'),
            analysis: any('质量分析结果（type、issueCodes 等），无统计数据时为 null'),
            charts: any('降采样后的图表数据：networkQuality、statisticsNetwork、statisticsMedia、callMetric'),
            timeline: any('关键事件时间线')
          })
        )
      },
      extra
    )
  );

module.exports = {
  str,
  num,
  bool,
  any,
  list,
  obj,
  success,
  empty,
  CONFERENCE_STATUS,
  member,
  conference,
  conferenceDetail,
  transcription,
  shorten,
  inviter,
  conferenceSummaryFields,
  instanceEventList,
  roomEventsSummary
};
