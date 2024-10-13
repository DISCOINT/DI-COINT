import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { ProductosModule } from './productos/productos.module';

@Module({
  imports: [UserModule, ProductosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
