import { Component, Input, Host } from '@angular/core';
import {
  CellClassParams,
  ColDef,
  ColSpanParams,
  ColumnApi,
  Events,
  GridApi,
  GridReadyEvent,
  ProcessCellForExportParams,
  RowNode,
  ValueGetterParams,
} from 'ag-grid-community';
import { fromEvent, merge } from 'rxjs';
import { debounceTime, filter, switchMap, tap } from 'rxjs/operators';
import { UntilDestroy, untilDestroyed } from '@ngneat/until-destroy';

import { GridUtils } from '@sdk/smart-grid/utils';

import {
  ExtendedColDef,
  SmartGridColumn,
  SmartGridFeatureSetupOptions,
  SmartGridHybridServerSideDataSourceOptions,
  SmartGridSortingOrder,
} from '../../model';

import { SdkGridFeatureBaseDirective } from '../../feature-base.directive';
import { SDK_GRID_FEATURE } from '../../tokens';
import { SmartGridRendererWithLoadingComponent } from '../../components';
import { SmartGridComponent } from './smart-grid.component';

@UntilDestroy()
@Component({
  selector: 'sdk-smart-grid-hybrid-server-side',
  template: '',
  providers:[
    { provide: SDK_GRID_FEATURE, useExisting: SmartGridHybridServerSideComponent },
  ],
})
export class SmartGridHybridServerSideComponent<TableEntity> extends SdkGridFeatureBaseDirective {
  @Input() dataSourceOptions: SmartGridHybridServerSideDataSourceOptions<TableEntity>;

  private columnApi: ColumnApi;
  private gridApi: GridApi;
  private readonly loadingRows = Array.from(Array(25).keys(), i => ({
    loading: true,
    id: 'loading' + i,
    hierarchyStructure: ['loading' + i],
  }));

  constructor(@Host() private SmartGrid: SmartGridComponent) {
    super();
  }

  onGridReady(params: GridReadyEvent): void {
    this.columnApi = params.columnApi;
    this.gridApi = params.api;

    this.updateColumns();
    this.observeShortPollingData();
    this.observeShortPollingLoading();
  }

  getFeatureSetup(tableId?: string): SmartGridFeatureSetupOptions {
    const featureToken = 'loadingRowDroppedFromFilteringIds';

    return {
      frameworkComponents: {
        BasicRenderer: SmartGridRendererWithLoadingComponent,
      },
      gridOptions: {
        isRowSelectable: (node: RowNode) => !node.data?.loading,
      },
      gridContext: {
        isRowFilterSkipped: (node: RowNode) => !window[`${featureToken}_${tableId}`]?.includes(node.data.id) && node.data.loading,
      },
    };
  }

  private updateColumns(): void {
    const autoGroupColDef = this.SmartGrid.gridOptions.autoGroupColumnDef;
    const columns = this.columnApi.getAllColumns();
    const updatedAutoGroupColDef = {
      ...autoGroupColDef,
      valueGetter: this.getValueGetterFn(autoGroupColDef),
      clipboardValueGetter: this.getClipboardGetterFn(autoGroupColDef),
      colSpan: ({ node }: ColSpanParams) => node.data?.loading ? (columns.length + 1) : 1,
      cellClassRules: {
        ...autoGroupColDef.cellClassRules,
        '-loading-cell': (cellParams: CellClassParams) => cellParams.data?.loading,
      },
      comparator: this.dummyComparator,
    };
    const colDefs = columns.map(column => {
      const colDef = column.getColDef();

      return { ...colDef, comparator: this.dummyComparator };
    });
    this.gridApi.setAutoGroupColumnDef(updatedAutoGroupColDef);
    this.gridApi.setColumnDefs(colDefs);
  }

  private observeShortPollingData(): void {
    merge(this.dataSourceOptions.additionalTriggerOn$, fromEvent(this.gridApi, Events.EVENT_FILTER_CHANGED), fromEvent(this.gridApi, Events.EVENT_SORT_CHANGED))
      .pipe(
        debounceTime(100),
        tap(() => this.gridApi.setRowData([])),
        switchMap(() => this.dataSourceOptions.getDataSource()),
        tap((dataChunk) => this.dataSourceOptions.dataEmitSubject.next(dataChunk)),
        untilDestroyed(this),
      )
      .subscribe();
  }

  private observeShortPollingLoading(): void {
    this.dataSourceOptions.loading$.pipe(
      filter(() => !this.gridApi['destroyCalled']),
      tap(isLoading => {
        const withLoadingNodes = !!this.gridApi?.getRowNode(this.loadingRows[0].id);
        if (withLoadingNodes && !isLoading) {
          this.gridApi.applyTransaction({ add: [], update: [], remove: this.loadingRows });
        } else if (!withLoadingNodes && isLoading) {
          this.gridApi.applyTransaction({ add: this.loadingRows, update: [], remove: [] });
        }
      }),
      untilDestroyed(this),
    )
      .subscribe();
  }

  // We need to suppress client side sorting w/o switching the functionality off
  private dummyComparator = (a, b, rowA: RowNode, rowB: RowNode, isInverted: boolean) => {
    if (rowA.data.loading || rowB.data.loading) {
      // pushes loading rows down, a.localeCompare(b) * -1 + 0 used to get inverted value of a.localeCompare(b)
      return isInverted ? a.localeCompare(b) : a.localeCompare(b) * -1 + 0;
    }
  };

  private getValueGetterFn(colDef: ColDef): (valueGetterParams: ValueGetterParams) => unknown {
    return (valueGetterParams: ValueGetterParams) => {
      const columnsState = this.columnApi.getColumnState();
      const correspondingColumnState = columnsState.find(columnState => columnState.colId === valueGetterParams.column.getColDef().colId);

      const maxCharCode = 10000;

      if (valueGetterParams.data?.loading) {
        return correspondingColumnState?.sort === SmartGridSortingOrder.ASC
          ? String.fromCharCode(maxCharCode)
          : String.fromCharCode(0);
      }

      return (<(params: ValueGetterParams) => string> colDef.valueGetter)(valueGetterParams)
        ?? (correspondingColumnState?.sort === SmartGridSortingOrder.ASC
          ? String.fromCharCode(maxCharCode)
          : String.fromCharCode(0));
    };
  }

  /** Designed to avoid `✐` that symbol caused by `getValueGetterFn` method on user copy to clipboard event at loading rows. */
  private getClipboardGetterFn({ clipboardValueGetter, valueGetter }: ExtendedColDef): SmartGridColumn['clipboardValueGetter'] {
    return (params: ProcessCellForExportParams): unknown => {
      if (clipboardValueGetter) {
        return clipboardValueGetter(params);
      }

      if (params.node.data.loading || GridUtils.isAggregation(params.value)) {
        return '';
      }

      return (<(params: Partial<ValueGetterParams>) => unknown> valueGetter)({ ...params, data: params.node.data });
    };
  }
}
