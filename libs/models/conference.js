module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        comment: '会议名称'
      },
      startTime: {
        type: DataTypes.DATE,
        comment: '开始时间'
      },
      duration: {
        type: DataTypes.INTEGER,
        comment: '会议时长'
      },
      isInvitationAllowed: {
        type: DataTypes.BOOLEAN,
        comment: '是否允许邀请人'
      },
      origin: {
        type: DataTypes.STRING,
        defaultValue: 'system-created',
        comment: '来源:system-created,co-interview'
      },
      maxCount: {
        type: DataTypes.INTEGER,
        defaultValue: 2,
        comment: '最大参会人数'
      },
      status: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '会议状态: 0正常，1:已结束'
      },
      options: {
        type: DataTypes.JSON,
        comment: '附属信息'
      }
    },
    associate: ({ conference, member }) => {
      conference.hasMany(member);
      conference.belongsTo(options.getUserModel());
    },
    options: {
      comment: '会议'
    }
  };
};
