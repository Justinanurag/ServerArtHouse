import mongoose from "mongoose";


const activitySchema=new mongoose.Schema({
    userId:{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
        required: true,
        index: true,
    },
    name: {
        type: String,
        trim: true,
    }  
    
})