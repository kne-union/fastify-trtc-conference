module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      content: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '语音转文字内容数据'
      },
      result: {
        type: DataTypes.JSON,
        comment: '语音转文字内容处理结果'
      },
      status: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '语音转文字状态'
      },
      options: {
        type: DataTypes.JSON,
        defaultValue: {},
        comment: '语音转文字附属信息'
      }
    },
    associate: ({ aiTranscriptionContent, conference }) => {
      aiTranscriptionContent.belongsTo(conference);
    },
    options: {
      comment: '语音转文字内容'
    }
  };
};
