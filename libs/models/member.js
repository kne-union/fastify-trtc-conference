module.exports = ({ DataTypes }) => {
  return {
    model: {
      email: {
        type: DataTypes.STRING,
        comment: '邮箱'
      },
      nickname: {
        type: DataTypes.STRING,
        comment: '昵称'
      },
      avatar: {
        type: DataTypes.STRING,
        comment: '头像'
      },
      isMaster: {
        type: DataTypes.BOOLEAN,
        comment: '是否是会议主持人'
      },
      shorten: {
        type: DataTypes.STRING,
        comment: '进入系统邀请码'
      }
    },
    associate: ({ conference, member }) => {
      member.belongsTo(conference);
    },
    options: {
      comment: '参会人员'
    }
  };
};
