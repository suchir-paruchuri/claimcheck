import { Schema, model } from 'mongoose';

const ncciEditSchema = new Schema(
  {
    column1: { type: String, required: true },
    column2: { type: String, required: true },
    version: { type: String, enum: ['practitioner', 'hospital'], required: true },
    modifierIndicator: { type: Number, enum: [0, 1], required: true },
    effectiveDate: { type: String, required: true },
    deletionDate: String,
    dataVersion: { type: String, required: true },
  },
  { versionKey: false },
);
// Lookups fetch every edit whose column-one code appears on the bill.
ncciEditSchema.index({ version: 1, column1: 1, column2: 1 });

const mueLimitSchema = new Schema(
  {
    code: { type: String, required: true },
    version: { type: String, enum: ['practitioner', 'hospital'], required: true },
    limit: { type: Number, required: true },
    mai: { type: Number, enum: [1, 2, 3], required: true },
    dataVersion: { type: String, required: true },
  },
  { versionKey: false },
);
mueLimitSchema.index({ version: 1, code: 1 }, { unique: true });

export const NcciEditModel = model('NcciEdit', ncciEditSchema);
export const MueLimitModel = model('MueLimit', mueLimitSchema);
