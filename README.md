# NMMS Attendance Shortcut

A small local website that fetches the official NMMS daily attendance report for **DN HAVELI AND DD**, automatically passes through **DADRA AND NAGAR HAVELI → Dadra Nagar Haveli**, and displays the panchayat summary.

Select a panchayat name or its muster-roll count to open an enriched muster-roll table. The website visits one official detail page per unique work code, adds the corresponding **work name**, and totals labour attendance across every muster roll belonging to that work. The enriched table can also be exported as CSV.

The **Attendance movement** section compares the seven recent days ending on the selected date. It includes:

- daily increase/decrease for the selected panchayat;
- seven-day personday totals for every reporting panchayat;
- daily and weekly labour attendance by work for the selected panchayat.

The comparison is limited to recent dates published by the NMMS daily-attendance portal.

## Start

Double-click **Open Attendance Website.cmd**. It starts the local website and opens it in Chrome, Edge, Firefox, or whichever browser is set as your Windows default.

Alternatively, right-click `start.ps1` and choose **Run with PowerShell**, or run:

```powershell
.\start.ps1
```

You can also type <http://127.0.0.1:4173> into any browser on this computer while the server is running.

The figures are requested live from the official NREGA/NMMS portal; internet access is required. The government portal normally exposes only its recent attendance dates.
