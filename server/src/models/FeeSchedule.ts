import { Schema, model } from 'mongoose';

const feeScheduleSchema = new Schema(
  {
    schedule: { type: String, enum: ['PFS', 'OPPS', 'CLFS'], required: true },
    code: { type: String, required: true },
    modifier: { type: String, default: null },
    description: String,
    nonFacilityRate: Number,
    facilityRate: Number,
    rate: Number,
    packaged: Boolean,
    version: { type: String, required: true },
  },
  { versionKey: false },
);

// Batch lookups query by code ($in), so code leads the index.
feeScheduleSchema.index({ code: 1, schedule: 1, modifier: 1, version: 1 }, { unique: true });

export const FeeSchedule = model('FeeSchedule', feeScheduleSchema);
