module.exports = async (fastify, options, { task, polling }) => {
  const trtc = fastify[options.trtcName].services;
  const { recordTaskId, conferenceId, roomId } = task.input;
  return polling(async () => {
    const recordTask = await trtc.checkRecord({ id: recordTaskId, roomId });
    if (recordTask.result && recordTask.result.length > 0) {
      return { result: 'success', data: { results: recordTask.result, recordTaskId, conferenceId, roomId } };
    }
    // 无结果，继续轮询
    return {};
  });
};
