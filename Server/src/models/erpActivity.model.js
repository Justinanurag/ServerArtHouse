import mongoose from 'mongoose';

const changeSchema = new mongoose.Schema(
  {
    field: {type: String, required: true},
    oldValue: {type: mongoose.Schema.Types.Mixed, default: null},
    newValue: {type: mongoose.Schema.Types.Mixed, default: null},
  },
  {_id: false},
);

const erpActivitySchema = new mongoose.Schema(
  {
    userId: {type: mongoose.Schema.Types.ObjectId, default: null, index: true},
    userName: {type: String, default: '', trim: true},
    userEmail: {type: String, default: '', trim: true, lowercase: true},
    actorType: {
      type: String,
      enum: ['Admin', 'Staff', 'Customer', 'System'],
      default: 'System',
      index: true,
    },
    action: {type: String, required: true, uppercase: true, trim: true, index: true},
    module: {type: String, required: true, trim: true, index: true},
    description: {type: String, default: '', trim: true},
    resourceId: {type: String, default: '', index: true},
    resourceName: {type: String, default: '', trim: true},
    resourceType: {type: String, default: '', trim: true},
    method: {type: String, default: ''},
    endpoint: {type: String, default: ''},
    status: {type: String, enum: ['success', 'failure'], default: 'success', index: true},
    ipAddress: {type: String, default: ''},
    requestId: {type: String, default: '', index: true},
    companyId: {type: String, default: '', index: true},
    changes: {type: [changeSchema], default: []},
    metadata: {type: mongoose.Schema.Types.Mixed, default: {}},
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

erpActivitySchema.index({createdAt: -1});
erpActivitySchema.index({module: 1, createdAt: -1});
erpActivitySchema.index({userId: 1, createdAt: -1});
erpActivitySchema.index({action: 1, createdAt: -1});
erpActivitySchema.index({status: 1, createdAt: -1});
erpActivitySchema.index({companyId: 1, createdAt: -1});

const ErpActivity = mongoose.model('ErpActivity', erpActivitySchema, 'erp_activities');

mongoose.connection.on('connected', () => {
  ErpActivity.collection
    .dropIndex('resourceName_text_userName_text_description_text')
    .catch(() => {});
});

export default ErpActivity;