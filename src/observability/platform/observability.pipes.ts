import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PipeTransform,
} from '@nestjs/common';
import { METRIC_CATALOG } from './metric-catalog';

/** A rule name is an identifier; it is later matched against Prometheus' own rules. */
@Injectable()
export class ParseRuleNamePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_:]{0,127}$/.test(value)) {
      throw new BadRequestException({ messageKey: 'errors.validation' });
    }
    return value;
  }
}

/** Only ids from the fixed catalog; there is no way to send a query. */
@Injectable()
export class ParseMetricIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!METRIC_CATALOG.some((m) => m.id === value)) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return value;
  }
}
