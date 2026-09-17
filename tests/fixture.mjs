// Fabricated records only. Never replace these with an athlete export.
export function fixture() {
  return {
    schemaVersion:'1.0',
    meta:{asOfDate:'2025-02-05',retrievedAt:'2025-02-05T09:00:00Z',timezone:'Europe/London',
      activityWindowStart:'2025-01-01',activityWindowEnd:'2025-02-05',activityLastDate:'2025-02-03',
      hrvLastDate:'2025-02-04',sleepLastDate:'2025-02-04',restHrLastDate:'2025-02-04',
      method:'Synthetic test data',privacy:'Fictional'},
    athlete:{name:'Demo athlete',marathonGoalSeconds:15000,marathonMonth:'Date to choose',marathonDate:null,recoveryEnd:null},
    activities:[{id:'synthetic-run-a',date:'2025-02-03',sport:'running',subSport:'generic',title:'Synthetic run',
      activeSeconds:1800,elapsedSeconds:1860,distanceM:4500,avgHr:125,avgPowerW:null,cadence:160,ascentM:null,race:null,source:'Synthetic'}],
    recovery:[{date:'2025-02-02',hrvMs:44,hrvBaselineMs:43,sleepSeconds:27000,sleepBaselineSeconds:27500,restHr:55},
      {date:'2025-02-04',hrvMs:null,hrvBaselineMs:null,sleepSeconds:28000,sleepBaselineSeconds:27500,restHr:54}],
    capacityIssue:{reportedFtpW:180,activitySnapshotFtpW:170,historicalHandoverFtpW:175,freshCapacityHistoryCount:0,verified:false},
    reportedBenchmarks:[],sources:[{title:'Synthetic fixture',detail:'Not an athlete record.'}],
    manualCheckins:[],manualBenchmarks:[],
    plan:{name:'Synthetic test plan',version:'demo-v1',status:'Conditional',volumeAmendments:[],workingFtpW:180,
      questions:[{id:'demo-context',stage:'Before progression',label:'Context',prompt:'Enter a fictional test note.'}],
      rules:{recovery:'Recovery is conditional.',ankle:'Blank symptoms are unknown.',gym:'Count gym time.',ftp:'Estimate only.',plyometrics:'No automatic clearance.'},
      weeks:[{week:1,start_date:'2025-02-03',end_date:'2025-02-09',core_slot_minutes:20,upper_range_slot_minutes:20,
        run_minutes:20,optional_cycle_minutes:0,weekly_ceiling_minutes:null,question_ids:['demo-context'],budget_note:'Synthetic',focus:'Synthetic week',
        days:[{day:'Monday',sport:'Rest',slot_minutes:0,optional:false,description:'Rest.'},
          {day:'Tuesday',sport:'Run',slot_minutes:20,optional:true,description:'Fictional session for rendering tests.'}]}]}
  };
}
