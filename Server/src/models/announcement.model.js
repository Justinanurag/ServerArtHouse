import mongoose from 'mongoose';
const announcementSchema = new mongoose.Schema({
    templateName:{type:String,required:true,trim:true},
    audienceType:{
        type:String,
        enum:["all","selected","exhibition"],
        required:true,
    },
  
    selectedCustomerIds:[{type:mongoose.Schema.Types.ObjectId,ref:"Customer"}],
    selectedExhibitionPassIds:[{type:mongoose.Schema.Types.ObjectId,ref:"ExhibitionPass"}],
    whatsappMetaTemplateName:{type:String,required:true,trim:true},
    languageCode:{type:String},
    templateParams:{type:[String],default:[]},
    /** Public HTTPS image URL for Meta IMAGE-header templates (e.g. newcafe) */
    headerImageLink:{type:String,default:''},
    /** WhatsApp media id when no public URL is available */
    headerImageId:{type:String,default:''},
    status:{
        type:String,
       enum: ["pending", "completed", "failed", "sending"],
        default:"pending",
        index:true,
    },
    totalRecipients:{type:Number,default:0},
    sentCount:{type:Number,default:0},
    failedCount:{type:Number,default:0},
    completedAt:{type:Date,default:null},
    lastError:{type:String,default:''},

    createdBNy:{
        m_staff_id:{type:String,default:null},
        m_staff_name:{type:String,default:null},
        m_staff_email:{type:String,default:null},
    },
},
{timestamps:true}
);
export default mongoose.model("Announcement",announcementSchema);